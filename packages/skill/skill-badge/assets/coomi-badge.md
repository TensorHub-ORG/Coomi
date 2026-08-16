# coomi Badge

Add the official “powered by coomi” badge without recreating or restyling it.

## Assets

- Local PNG: [`coomi-badge.png`](coomi-badge.png), 726×120 source image; render at 121×20
- Shields.io image URL: `https://img.shields.io/badge/powered_by-coomi-4D6BFE?style=flat-square&logo=deepseek&logoColor=white`
- Project URL: `https://github.com/coomi/coomi-desktop`

## Markdown

Use this linked badge in Markdown:

```markdown
[![](https://img.shields.io/badge/powered_by-coomi-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/coomi/coomi-desktop)
```

If attribution should not be linked, use:

```markdown
![](https://img.shields.io/badge/powered_by-coomi-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)
```

## Usage rules

- For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
- For Feishu and other systems that import remote images unreliably, upload `coomi-badge.png` from this skill directory instead of generating another badge.
- Preserve the badge's 121×20 dimensions and aspect ratio.
- Place the badge at the end of the attributed document or section unless the user specifies another position.
- Do not substitute another color, logo, label, or project URL.
