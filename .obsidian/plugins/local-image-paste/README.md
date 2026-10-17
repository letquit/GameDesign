# Local Image Paste（本地图片粘贴）

粘贴图片时自动落盘，并插入 GitHub 也能显示的相对路径。用于替代原来的 `image-size` 插件。
（`image-size` 已被停用，`main.js` 等文件仍保留在 `.obsidian/plugins/image-size/`，需要时可再启用。）

## 路径规则

图片保存到 `assets/<笔记名>/<笔记名>-<序号>.<扩展名>`，序号自动接续已有文件：

```
assets/TheSims-AI/TheSims-AI-1.png
assets/TheSims-AI/TheSims-AI-2.png
...
```

插入的链接相对于当前笔记，因此在库根目录的笔记里就是：

```markdown
![](assets/TheSims-AI/TheSims-AI-1.png)
```

笔记在子文件夹里时会自动加 `../`（在 GitHub 上同样能解析）：

```markdown
![](../assets/sub/sub-1.png)
```

## 三种粘贴来源

| 来源 | 行为 |
| --- | --- |
| 截图 / 复制的图片（剪贴板里是图片数据） | 原样写成 png/jpg/webp… 并插入本地链接 |
| 网页图片（复制后是一段 `![](https://…)`） | 下载到本地，替换成本地链接（保留 alt 文字） |
| 只有 HTML 剪贴板 / 裸图片网址 | 同上；普通文字和不像图片的网址不拦截 |

网页图片这一条不依赖剪贴板的具体格式：插件先让 Obsidian 正常粘贴，随后把刚粘进来的
远程图片链接改写为本地文件。所以飞书那种 `…/asynccode/?code=…`、没有文件扩展名的 CDN
链接也能识别（靠响应的 `content-type` 判断是不是图片）。粘贴后可能会闪一下裂图，几百毫秒
后变成正常图片。

下载失败（403、断网等）不会丢内容：提示一个 Notice，并保留原始链接。

## 命令

`Download remote images in current note into local assets`（命令面板 / 快捷键）
把当前笔记里所有 `![](https://…)` 图片逐个下载到本地并替换链接，用于修复以前粘进来的
飞书临时链接（这类链接过期后 GitHub 上就是裂图）。

## 设置

- **Storage folder**：根目录，默认 `assets`。
- **Download remote image links**：是否把网页图片下载到本地，默认开。

## 单篇笔记指定文件夹

如果笔记文件名和目标文件夹名不一致（例如笔记 `TheSimsAI.md`，但图片想继续放在
`assets/TheSims-AI/`），在笔记 YAML frontmatter 里加一行即可：

```yaml
---
image_folder: TheSims-AI
---
```

之后该笔记的图片写入 `assets/TheSims-AI/TheSims-AI-<序号>.png`。
`TheSimsAI.md` 已经加好了这一行，新图片会接着 `-11.png` 继续编号。

## 生效方式

改完插件后需要重载 Obsidian：`Ctrl+R`（或在「设置 → 第三方插件」里关掉再打开）。
