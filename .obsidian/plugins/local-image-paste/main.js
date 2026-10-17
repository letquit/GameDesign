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
	if (bare && looksLikeImageUrl(bare[1])) {
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

/**
 * Many image CDNs (Feishu `asynccode`, Google avatars, CDN proxies) serve
 * images from URLs without a file extension, so a missing extension is not
 * evidence that the link is not an image.
 */
function looksLikeImageUrl(url) {
	const value = String(url == null ? '' : url);
	if (!/^https?:\/\//i.test(value)) return false;
	if (extensionFromUrl(value)) return true;
	return /(?:^|[\/._-])(?:image|images|img|imgproxy|photo|photos|picture|avatar|media|thumbnail|thumb|asynccode|download|file)(?:[\/._?=&-]|$)/i
		.test(value.replace(/^https?:\/\//i, ''));
}

function remoteImagePattern() {
	return /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/g;
}

/** True when the text Obsidian inserted is one remote image (markdown or a bare URL). */
function isRemoteImageText(text) {
	const value = String(text == null ? '' : text);
	if (!value.trim()) return false;
	if (remoteImagePattern().test(value)) return true;
	const bare = value.trim().match(/^<?(https?:\/\/\S+?)>?$/i);
	return Boolean(bare && looksLikeImageUrl(bare[1]));
}

/** Cheap pre-check so only image-ish pastes pay for a content snapshot. */
function clipboardMayHoldRemoteImage(text, html) {
	if (/<img\b/i.test(String(html || ''))) return true;
	const trimmed = String(text == null ? '' : text).trim();
	if (!trimmed) return false;
	if (remoteImagePattern().test(trimmed)) return true;
	const bare = trimmed.match(/^<?(https?:\/\/\S+?)>?$/i);
	return Boolean(bare && looksLikeImageUrl(bare[1]));
}

/** Locates the text a paste added: common prefix/suffix of before and after. */
function insertedRegion(before, after) {
	const oldText = String(before == null ? '' : before);
	const newText = String(after == null ? '' : after);
	const max = Math.min(oldText.length, newText.length);
	let start = 0;
	while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1;
	let tailOld = oldText.length;
	let tailNew = newText.length;
	while (
		tailOld > start
		&& tailNew > start
		&& oldText.charCodeAt(tailOld - 1) === newText.charCodeAt(tailNew - 1)
	) {
		tailOld -= 1;
		tailNew -= 1;
	}
	return { start, end: tailNew, inserted: newText.slice(start, tailNew) };
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
		if (!clipboardMayHoldRemoteImage(text, html)) return;

		// Clipboard shapes vary wildly per site (markdown, bare URL, rich HTML,
		// or several of them at once), so do not try to insert anything
		// ourselves: let Obsidian paste natively, then rewrite whatever landed
		// in the editor into a local asset.
		const snapshot = editor.getValue();
		this.watchPastedRegion(editor, noteFile, snapshot, remoteImageRef(text, html));
	}

	/**
	 * Waits for Obsidian to finish its own paste, finds the inserted text and
	 * replaces remote image links inside it. Retries briefly because the native
	 * paste can land a few frames after the `editor-paste` event.
	 */
	watchPastedRegion(editor, noteFile, snapshot, fallback, attempt) {
		const tries = typeof attempt === 'number' ? attempt : 6;
		const timer = setTimeout(() => {
			let current;
			try {
				current = editor.getValue();
			} catch (err) {
				return;
			}
			const region = insertedRegion(snapshot, current);

			if (!region.inserted.trim()) {
				if (tries > 0) {
					this.watchPastedRegion(editor, noteFile, snapshot, fallback, tries - 1);
				} else if (fallback) {
					this.enqueue(() => this.downloadRemoteImage(editor, noteFile, fallback));
				}
				return;
			}

			if (!isRemoteImageText(region.inserted)) return;

			this.enqueue(async () => {
				const result = await this.localizeText(region.inserted, noteFile, { notify: true });
				if (result.text === region.inserted) return;
				if (typeof editor.offsetToPos !== 'function') return;

				// The download may take a moment; only rewrite when the pasted
				// region is still exactly where it was, otherwise locate it again
				// by content and give up if it is ambiguous.
				const latest = editor.getValue();
				let start = region.start;
				let end = region.end;
				if (latest.slice(start, end) !== region.inserted) {
					const first = latest.indexOf(region.inserted);
					if (first < 0 || latest.indexOf(region.inserted, first + 1) >= 0) return;
					start = first;
					end = first + region.inserted.length;
				}
				editor.replaceRange(result.text, editor.offsetToPos(start), editor.offsetToPos(end));
			});
		}, 45);
		this.register(() => clearTimeout(timer));
	}

	/**
	 * Replaces every remote image reference in `text` with a local asset link.
	 * Unreachable images keep their original link, so nothing is ever lost.
	 */
	async localizeText(text, noteFile, options) {
		const opts = options || {};
		const source = String(text == null ? '' : text);
		const items = [];
		const pattern = remoteImagePattern();
		let match;
		while ((match = pattern.exec(source)) !== null) {
			items.push({ index: match.index, length: match[0].length, alt: match[1], url: match[2] });
		}

		let bareMode = false;
		if (items.length === 0) {
			const bare = source.trim().match(/^<?(https?:\/\/\S+?)>?$/i);
			if (bare && looksLikeImageUrl(bare[1])) {
				bareMode = true;
				items.push({ index: 0, length: source.length, alt: '', url: bare[1] });
			}
		}
		if (items.length === 0) return { text: source, replaced: 0, failed: [] };

		const pieces = [];
		let cursor = 0;
		let replaced = 0;
		const failed = [];
		let lastError = null;

		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			pieces.push(source.slice(cursor, item.index));
			cursor = item.index + item.length;
			try {
				const downloaded = await fetchRemoteImage(item.url);
				const vaultPath = await this.writeImage(downloaded.bytes, downloaded.ext, noteFile);
				pieces.push(this.markdownFor(vaultPath, noteFile, item.alt));
				replaced += 1;
			} catch (err) {
				console.error('[local-image-paste] could not localize ' + item.url, err);
				failed.push(item.url);
				lastError = err;
				pieces.push(bareMode ? source : '![' + item.alt + '](' + item.url + ')');
			}
		}
		pieces.push(source.slice(cursor));

		if (opts.notify && replaced === 0 && failed.length > 0) {
			new Notice('Could not download the pasted image ('
				+ (lastError && lastError.message ? lastError.message : 'request failed')
				+ '); kept the original link.');
		}
		return { text: pieces.join(''), replaced, failed };
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

		const found = [];
		const pattern = remoteImagePattern();
		let match;
		while ((match = pattern.exec(content)) !== null) found.push(match[2]);
		if (found.length === 0) {
			new Notice('No remote images found in this note.');
			return;
		}

		const progress = new Notice('Downloading ' + found.length + ' image(s)…', 0);
		try {
			const result = await this.localizeText(content, noteFile);
			if (result.replaced > 0) {
				const lastLine = editor.lastLine();
				editor.replaceRange(
					result.text,
					{ line: 0, ch: 0 },
					{ line: lastLine, ch: editor.getLine(lastLine).length },
				);
			}
			new Notice(
				'Localized ' + result.replaced + ' image(s)'
				+ (result.failed.length > 0 ? ', ' + result.failed.length + ' failed' : '') + '.',
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
	looksLikeImageUrl: looksLikeImageUrl,
	isRemoteImageText: isRemoteImageText,
	clipboardMayHoldRemoteImage: clipboardMayHoldRemoteImage,
	insertedRegion: insertedRegion,
};
