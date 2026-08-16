# Stript MCP Bridge

`@stript/mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude (Desktop and Code) anonymize documents through the **Stript** desktop app **on your own
machine** — so personal data never enters the conversation.

> **Requires the Stript desktop app** with **AI integrations** enabled in Settings. The bridge does
> nothing on its own; it is a thin, local client to the app.

## What it does

Claude hands the bridge a *local reference* — a file path, the clipboard, or an existing Stript
document id. The bridge asks the **local** Stript app to detect personal data and replace it with
consistent placeholders like `[PERSON_1]`. Only the anonymized text is returned to the conversation.
Restored (real-PII) output is written to your clipboard or a local file and is **never** returned to
the model.

## Install

**Claude Desktop** — install the signed `Stript.mcpb` from the Stript app
(Settings → *Install for Claude Desktop*), or from `https://downloads.stript.io/Stript.mcpb`.

**Claude Code:**

```bash
claude mcp add stript -- npx -y @stript/mcp
```

## Tools

| Tool | Purpose | Nature |
|------|---------|--------|
| Check the Stript app status | Confirm the app is running and reachable | read-only |
| Anonymize a document with Stript | Detect + replace PII in a file on disk | writes anonymized output |
| Anonymize the clipboard text with Stript | Same, for the current clipboard (opt-in; Claude asks first) | writes anonymized output |
| Fetch a Stript anonymization result | Retrieve a completed result | read-only |
| Restore original values into placeholder text | Put the real values back (to clipboard or a local file) | writes locally, never to chat |
| Restore original values into a file | Restore a full file on disk | writes locally, never to chat |

## How it works — privacy by design

- The bridge talks **only to `127.0.0.1`**: the Stript app's local backend and a loopback broker
  inside the signed app. It makes **no external network calls** with your content.
- A **per-launch, scope-restricted token** gates every call; ports and token rotate on each launch.
- **Restored real values never enter tool results** — they are written to your clipboard or a local
  file only.
- New documents meter through the same local path as the app; the bridge keeps only a small **local**
  usage-metering mirror and nothing else persistent.

## Privacy Policy

Stript is local-first. From the [Stript Privacy Policy](https://stript.io/en/privacy):

> "Your documents are processed exclusively on your own device."
>
> "No document content, file name, path, document identifier, source commitment, mapping, detection
> result, entity information, or export activity is transmitted to us or any third party."

**This bridge inherits that guarantee:**

- **Collects and transmits no document content.** All detection and anonymization run locally in the
  Stript app; the bridge only shuttles data between Claude and the local app over loopback.
- **Stores nothing** beyond a local usage-metering mirror on your own machine.
- **Shares nothing** with third parties — it makes no off-device network calls.

The broader Stript product's data handling — optional account email, payment processing via Lemon
Squeezy, hosting and privacy-preserving analytics via Cloudflare, transactional email via Resend, and
the associated retention periods and contact details — is described in full in the
[Privacy Policy](https://stript.io/en/privacy). Direct privacy questions to the contact listed there.

## Build from source

```bash
npm ci
npm run build     # bundles dist/index.js (esm, node20)
npm test          # vitest
npm run check     # tsc --strict (bridge + card UI)
```

## License

[MIT](LICENSE). The Stript desktop app this bridge connects to is a separate, proprietary product.
