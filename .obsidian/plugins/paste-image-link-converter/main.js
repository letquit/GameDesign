const { Plugin, Notice } = require("obsidian");

module.exports = class PasteImageLinkConverter extends Plugin {
  async onload() {
    this.addCommand({
      id: "convert-pasted-image-links",
      name: "Convert pasted image links to Markdown (assets/...)",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file.");
          return;
        }

        const content = await this.app.vault.read(file);

        // 匹配：![[Pasted image 20260204222746.png|550]]
        // 也兼容没有尺寸的情况：![[Pasted image 20260204222746.png]]
        const regex = /!\[\[(Pasted image \d{14}\.png)(?:\|[^\]]+)?\]\]/g;

        const replaced = content.replace(regex, "![](assets/$1)");

        if (replaced === content) {
          new Notice("No matching pasted image links found.");
          return;
        }

        await this.app.vault.modify(file, replaced);
        new Notice("Converted pasted image links.");
      }
    });
  }
};