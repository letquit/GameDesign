'use strict';

/*
 * Local Image Paste
 *
 * Every image that enters a note becomes a real file inside the vault:
 *
 *     assets/<note-name>/<note-name>-<n>.<ext>
 *
 * and the editor receives a normal markdown image link whose path is relative
 * to the note, e.g. a note at the vault root yields
 *
 *     ![](assets/TheSims-AI/TheSims-AI-1.png)
 *
 * so the same link resolves both in Obsidian and on GitHub. Handled inputs:
 *
 *   1. clipboard image data (screenshot / copied picture)  -> saved as-is
 *   2. markdown image with an http(s) source (`![](https://...)`) -> downloaded
 *   3. bare http(s) image URL, or an HTML <img> only clipboard -> downloaded
 *
 * A note can point at a different folder with frontmatter
 *
 *     ---
 *     image_folder: TheSims-AI
 *     ---
 *
 * which yields assets/TheSims-AI/TheSims-AI-1.png.
 *
 * The command "Download remote images in current note" converts images that
 * were pasted before this plugin existed (e.g. temporary CDN links).
 */

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownView,
	requestUrl,
} = require('obsidian');

const DEFAULT_SETTINGS = {
	rootDir: 'assets',
	downloadRemoteUrls: true,
};

const MIME_TO_EXT = {
	'image/png': 'png',
	'image/apng': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/pjpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/x-ms-bmp': 'bmp',
	'image/svg+xml': 'svg',
	'image/avif': 'avif',
	'image/tiff': 'tiff',
	'image/heic': 'heic',
	'image/heif': 'heic',
};

const IMAGE_EXTENSIONS = [
	'png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff', 'heic', 'heif',
];

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for the test harness)
 * ------------------------------------------------------------------ */

function sanitizeSegment(name) {
	const cleaned = String(name == null ? '' : name)
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[. ]+/, '')
		.replace(/[. ]+$/, '');
	return cleaned || 'untitled';
}

function normalizeRootDir(dir) {
	return String(dir == null ? '' : dir)
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\/{2,}/g, '/');
}

/** Path from the note's folder to `targetPath`, both vault-relative. */
function relativeLink(fromDir, targetPath) {
	const from = String(fromDir || '').split('/').filter(Boolean);
	const to = String(targetPath || '').split('/').filter(Boolean);
	if (to.length === 0) return '';
	let shared = 0;
	while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
		shared += 1;
	}
	const parts = [];
	for (let i = shared; i < from.length; i += 1) parts.push('..');
	for (let i = shared; i < to.length; i += 1) parts.push(to[i]);
	return parts.join('/');
}

/** Escape only what actually breaks a markdown/URL link target. */
function encodeLinkPath(linkPath) {
	return String(linkPath)
		.split('/')
		.map((segment) => segment
			.replace(/%/g, '%25')
			.replace(/ /g, '%20')
			.replace(/#/g, '%23')
			.replace(/\?/g, '%3F'))
		.join('/');
}

function extensionFromMime(mime) {
	const base = String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase();
	return MIME_TO_EXT[base] || null;
}

function extensionFromUrl(url) {
	try {
		const parsed = new URL(String(url));
		const match = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i);
		if (!match) return null;
		const ext = match[1].toLowerCase();
		if (!IMAGE_EXTENSIONS.includes(ext)) return null;
		return ext === 'jpeg' ? 'jpg' : ext;
	} catch (err) {
		return null;
	}
}

function decodeHtmlAttribute(value) {
	return String(value)
		.replace(/^[\s"']+|[\s"']+$/g, '')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function singleImageSrcFromHtml(html) {
	const re = /<img\b[^>]*\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
	const sources = [];
	let match;
	while ((match = re.exec(String(html || ''))) !== null) {
		sources.push(decodeHtmlAttribute(match[1]));
		if (sources.length > 1) return null;
	}
	if (sources.length !== 1) return null;
	return /^https?:\/\//i.test(sources[0]) ? sources[0] : null;
}

/**
 * Recognises clipboard text that points at exactly one remote image.
 * Returns { url, alt, fallback } or null. `fallback` is what gets inserted
 * verbatim when the download fails, so nothing is lost.
 */
function remoteImageRefFromText(text) {
	const raw = String(text == null ? '' : text);
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.includes('\n')) return null;

	const markdown = trimmed.match(/^!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)$/i);
	if (markdown) {
		return { url: markdown[2], alt: markdown[1], fallback: raw };
	}

	const htmlImg = singleImageSrcFromHtml(trimmed);
	if (htmlImg) {
		return { url: htmlImg, alt: '', fallback: raw };
	}

	const bare = trimmed.match(/^(https?:\/\/\S+)$/i);
	if (bare && extensionFromUrl(bare[1])) {
		return { url: bare[1], alt: '', fallback: raw };
	}

	return null;
}

function remoteImageRef(text, html) {
	const fromText = remoteImageRefFromText(text);
	if (fromText) return fromText;
	if (String(text || '').trim()) return null;
	const source = singleImageSrcFromHtml(html);
	if (!source) return null;
	return { url: source, alt: '', fallback: `![](${source})` };
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function noteFolderOf(file) {
	const path = file && file.parent && file.parent.path;
	return !path || path === '/' ? '' : path;
}

async function blobToArrayBuffer(blob) {
	if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error || new Error('Could not read clipboard image'));
		reader.readAsArrayBuffer(blob);
	});
}

function collectClipboardImages(clipboardData) {
	const out = [];
	const items = clipboardData && clipboardData.items;
	if (items && typeof items.length === 'number') {
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			if (!item || item.kind !== 'file') continue;
			if (!item.type || item.type.indexOf('image/') !== 0) continue;
			const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
			if (file) out.push({ blob: file, type: item.type });
		}
	}
	if (out.length === 0 && clipboardData && clipboardData.files) {
		const files = clipboardData.files;
		for (let i = 0; i < files.length; i += 1) {
			const file = files[i];
			if (file && file.type && file.type.indexOf('image/') === 0) {
				out.push({ blob: file, type: file.type });
			}
		}
	}
	return out;
}

function headerValue(headers, name) {
	if (!headers) return '';
	const wanted = String(name).toLowerCase();
	const keys = Object.keys(headers);
	for (let i = 0; i < keys.length; i += 1) {
		if (keys[i].toLowerCase() === wanted) return String(headers[keys[i]] || '');
	}
	return '';
}

async function fetchRemoteImage(url) {
	const response = await requestUrl({ url: url, method: 'GET', throw: false });
	if (!response) throw new Error('empty response');
	if (response.status < 200 || response.status >= 300) {
		throw new Error('HTTP ' + response.status);
	}
	const contentType = headerValue(response.headers, 'content-type');
	const bytes = response.arrayBuffer;
	if (!bytes || !bytes.byteLength) throw new Error('response body is empty');
	const ext = extensionFromMime(contentType) || extensionFromUrl(url);
	if (!ext) {
		throw new Error('response is not an image (content-type: ' + (contentType || 'unknown') + ')');
	}
	return { bytes: bytes, ext: ext };
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

class LocalImagePastePlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this._queue = Promise.resolve();

		this.addSettingTab(new LocalImagePasteSettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on(
			'editor-paste',
			(evt, editor, view) => this.handleEditorPaste(evt, editor, view),
		));

		this.addCommand({
			id: 'download-remote-images-in-note',
			name: 'Download remote images in current note into local assets',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) return false;
				if (!checking) this.localizeActiveNote();
				return true;
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* ------------------------- paste entry points ------------------------- */

	handleEditorPaste(evt, editor, view) {
		const clipboardData = evt && evt.clipboardData;
		if (!clipboardData || !editor) return;

		const noteFile = (view && view.file) || this.app.workspace.getActiveFile();
		if (!noteFile) return;

		const images = collectClipboardImages(clipboardData);
		if (images.length > 0) {
			evt.preventDefault();
			this.enqueue(() => this.saveClipboardImages(editor, noteFile, images));
			return;
		}

		if (!this.settings.downloadRemoteUrls) return;

		const text = readClipboardText(clipboardData, 'text/plain');
		const html = readClipboardText(clipboardData, 'text/html');
		const ref = remoteImageRef(text, html);
		if (!ref) return;

		evt.preventDefault();
		this.enqueue(() => this.downloadRemoteImage(editor, noteFile, ref));
	}

	/* ---------------------------- work queue ----------------------------- */

	enqueue(task) {
		const run = this._queue
			.then(() => task())
			.catch((err) => {
				console.error('[local-image-paste]', err);
				new Notice('Image paste failed: ' + (err && err.message ? err.message : err));
			});
		this._queue = run;
		return run;
	}

	/* ---------------------------- saving -------------------------------- */

	async saveClipboardImages(editor, noteFile, images) {
		const snippets = [];
		for (let i = 0; i < images.length; i += 1) {
			const entry = images[i];
			try {
				const bytes = await blobToArrayBuffer(entry.blob);
				const ext = extensionFromMime(entry.type)
					|| extensionFromUrl(entry.blob && entry.blob.name)
					|| 'png';
				const vaultPath = await this.writeImage(bytes, ext, noteFile);
				snippets.push(this.markdownFor(vaultPath, noteFile, ''));
			} catch (err) {
				console.error('[local-image-paste] could not save pasted image', err);
				new Notice('Could not save pasted image: ' + (err && err.message ? err.message : err));
			}
		}
		if (snippets.length > 0) this.insertText(editor, snippets.join('\n'));
	}

	async downloadRemoteImage(editor, noteFile, ref) {
		let downloaded;
		try {
			downloaded = await fetchRemoteImage(ref.url);
		} catch (err) {
			console.error('[local-image-paste] could not download ' + ref.url, err);
			new Notice('Could not download image (' + (err && err.message ? err.message : err)
				+ '); kept the original link.');
			this.insertText(editor, ref.fallback);
			return;
		}
		const vaultPath = await this.writeImage(downloaded.bytes, downloaded.ext, noteFile);
		this.insertText(editor, this.markdownFor(vaultPath, noteFile, ref.alt || ''));
	}

	/**
	 * Folder / file-name prefix for a note: its frontmatter `image_folder`
	 * when present, otherwise the note's own name.
	 */
	imageBaseName(noteFile) {
		let override = '';
		try {
			const cache = this.app.metadataCache.getFileCache(noteFile);
			const frontmatter = cache && cache.frontmatter;
			if (frontmatter) {
				const value = frontmatter.image_folder || frontmatter.imageFolder;
				if (typeof value === 'string') override = value.trim();
			}
		} catch (err) {
			override = '';
		}
		return override || (noteFile && noteFile.basename) || 'untitled';
	}

	/** Writes bytes to assets/<note-name>/<note-name>-<n>.<ext> and returns the vault path. */
	async writeImage(bytes, ext, noteFile) {
		const base = sanitizeSegment(this.imageBaseName(noteFile));
		const root = normalizeRootDir(this.settings.rootDir);
		const folder = root ? root + '/' + base : base;
		await this.ensureFolder(folder);

		const adapter = this.app.vault.adapter;
		let index = (await this.scanMaxIndex(folder, base)) + 1;
		let path = folder + '/' + base + '-' + index + '.' + ext;
		while (await adapter.exists(path)) {
			index += 1;
			path = folder + '/' + base + '-' + index + '.' + ext;
		}
		await this.app.vault.createBinary(path, bytes);
		return path;
	}

	async scanMaxIndex(folder, base) {
		const adapter = this.app.vault.adapter;
		let max = 0;
		try {
			if (!(await adapter.exists(folder))) return 0;
			const listing = await adapter.list(folder);
			const files = (listing && listing.files) || [];
			const pattern = new RegExp('^' + escapeRegExp(base) + '-(\\d+)\\.[a-z0-9]+$', 'i');
			for (let i = 0; i < files.length; i += 1) {
				const name = String(files[i]).split('/').pop();
				const match = name.match(pattern);
				if (match) max = Math.max(max, parseInt(match[1], 10));
			}
		} catch (err) {
			console.warn('[local-image-paste] could not scan ' + folder, err);
		}
		return max;
	}

	async ensureFolder(folder) {
		const adapter = this.app.vault.adapter;
		const parts = String(folder).split('/').filter(Boolean);
		let current = '';
		for (let i = 0; i < parts.length; i += 1) {
			current = current ? current + '/' + parts[i] : parts[i];
			if (await adapter.exists(current)) continue;
			try {
				await adapter.mkdir(current);
			} catch (err) {
				if (!(await adapter.exists(current))) throw err;
			}
		}
	}

	/* ---------------------------- links --------------------------------- */

	markdownFor(vaultPath, noteFile, alt) {
		const linkPath = encodeLinkPath(relativeLink(noteFolderOf(noteFile), vaultPath));
		return '![' + (alt || '') + '](' + linkPath + ')';
	}

	insertText(editor, text) {
		editor.replaceSelection(text);
	}

	/* ------------------- localize an existing note ----------------------- */

	async localizeActiveNote() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice('Open a note first.');
			return;
		}
		const editor = view.editor;
		const noteFile = view.file;
		const content = editor.getValue();

		const pattern = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/g;
		const found = [];
		let match;
		while ((match = pattern.exec(content)) !== null) {
			found.push({
				index: match.index,
				length: match[0].length,
				alt: match[1],
				url: match[2],
			});
		}
		if (found.length === 0) {
			new Notice('No remote images found in this note.');
			return;
		}

		const progress = new Notice('Downloading ' + found.length + ' image(s)…', 0);
		const pieces = [];
		let cursor = 0;
		let replaced = 0;
		const failed = [];

		try {
			for (let i = 0; i < found.length; i += 1) {
				const item = found[i];
				pieces.push(content.slice(cursor, item.index));
				cursor = item.index + item.length;
				try {
					const downloaded = await fetchRemoteImage(item.url);
					const vaultPath = await this.writeImage(downloaded.bytes, downloaded.ext, noteFile);
					pieces.push(this.markdownFor(vaultPath, noteFile, item.alt));
					replaced += 1;
				} catch (err) {
					console.error('[local-image-paste] could not localize ' + item.url, err);
					failed.push(item.url);
					pieces.push('![' + item.alt + '](' + item.url + ')');
				}
			}
			pieces.push(content.slice(cursor));

			if (replaced > 0) {
				const lastLine = editor.lastLine();
				editor.replaceRange(
					pieces.join(''),
					{ line: 0, ch: 0 },
					{ line: lastLine, ch: editor.getLine(lastLine).length },
				);
			}
			new Notice(
				'Localized ' + replaced + ' image(s)'
				+ (failed.length > 0 ? ', ' + failed.length + ' failed' : '') + '.',
			);
		} finally {
			if (progress && typeof progress.hide === 'function') progress.hide();
		}
	}
}

function readClipboardText(clipboardData, type) {
	try {
		return clipboardData && typeof clipboardData.getData === 'function'
			? String(clipboardData.getData(type) || '')
			: '';
	} catch (err) {
		return '';
	}
}

class LocalImagePasteSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Storage folder')
			.setDesc('Root folder for pasted images. Each note gets its own subfolder named after the note, '
				+ 'for example “assets/TheSims-AI/TheSims-AI-1.png”.')
			.addText((text) => text
				.setPlaceholder('assets')
				.setValue(this.plugin.settings.rootDir)
				.onChange(async (value) => {
					this.plugin.settings.rootDir = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Download remote image links')
			.setDesc('When you paste a web image (a markdown image with an http(s) address, or an image URL), '
				+ 'download it into the vault instead of keeping the remote link.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.downloadRemoteUrls)
				.onChange(async (value) => {
					this.plugin.settings.downloadRemoteUrls = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			text: 'Images go to assets/<note name>/<note name>-<n>.<ext>, and links are inserted relative '
				+ 'to the note so that “assets/note-name/note-name-1.png” resolves in Obsidian and on GitHub. '
				+ 'Add “image_folder: some-name” to a note’s frontmatter to store its images in '
				+ 'assets/some-name/some-name-<n>.<ext> instead.',
		});
	}
}

module.exports = LocalImagePastePlugin;
module.exports.default = LocalImagePastePlugin;
module.exports.__internals = {
	sanitizeSegment: sanitizeSegment,
	normalizeRootDir: normalizeRootDir,
	relativeLink: relativeLink,
	encodeLinkPath: encodeLinkPath,
	extensionFromMime: extensionFromMime,
	extensionFromUrl: extensionFromUrl,
	remoteImageRef: remoteImageRef,
	remoteImageRefFromText: remoteImageRefFromText,
	singleImageSrcFromHtml: singleImageSrcFromHtml,
	collectClipboardImages: collectClipboardImages,
	fetchRemoteImage: fetchRemoteImage,
};
