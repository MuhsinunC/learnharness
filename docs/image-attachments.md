# Image attachments

A learner can attach an image to a chat message in three ways: paste it (a screenshot from the clipboard), drop it on the composer, or type or paste its file path. This note records what existed before, how Claude Code handles the same thing, and the design LearnHarness uses.

## What existed before (v0.3.8)

- **The composer couldn't take images.** `components/composer.tsx` had no paste, drop or file handling, and the `text` input event (`src/core/input-events.ts`) carried a string only.
- **That was deliberate.** The sources work of 2026-09-19 decided against attachments. `src/agent/tools/fs-shared.ts` says "user decision: no attachments — the learner references files in messages; the agent finds them". `src/agent/tools/read.ts` says "nothing is auto-injected". The only way an image reached a model was the agent calling `read` on a path the learner had pasted. That tool reads any path and stores the base64 pixels in the chat record.
- **LH-39 supersedes that decision.** This change follows the owner's request (OB-0646).
- **The app had no durable-copy pattern to follow.** PDFs are read from their original path by the pdf-reader sub-agent. A notes import extracts the text and keeps no copy of the file. The attachment store is a new pattern.

## How Claude Code does it

- **Adding images.** You can drag and drop an image, paste it with Ctrl+V, or give a path ("Analyze this image: /path/to/your/image.png"). Claude refers to attached images as `[Image #1]`. Source: [Common workflows: Work with images](https://code.claude.com/docs/en/common-workflows).
- **Reading images.** The Read tool returns PNG, JPEG, GIF and WebP files "as visual content that Claude can see, not as raw bytes". It resizes and recompresses large images to fit the model's limits. Source: [Tools reference: Read](https://code.claude.com/docs/en/tools-reference).
- **Pasted images ride inline.** In a local Claude Code transcript (JSONL), a pasted image is a base64 `image` block inside the user message. It is therefore resent with every request until compaction. This was observed on this machine, not documented.
- **Compaction.** "Replaces the conversation with a structured summary". Afterwards, Claude Code re-reads up to five recently used files; the docs do not list images among what survives. Source: [Explore the context window](https://code.claude.com/docs/en/context-window).
- **API facts that shaped the design.** Source for all of these: [Vision](https://platform.claude.com/docs/en/build-with-claude/vision).
  - Supported formats are JPEG, PNG, GIF and WebP. BMP is not supported.
  - The limit is 10 MB per image, base64-encoded, on the Claude API (5 MB on Bedrock).
  - "Claude has access to every image from earlier turns".
  - The docs warn that base64 images are "included in the payload on every turn".

## Design

- **The store.** `src/store/attachments.ts` keeps every image at `<LH_DATA_DIR>/attachments/<sha256>.<ext>`.
  - The format is sniffed from the magic bytes, never the filename: png, jpg, gif or webp.
  - Each image is capped at 7 MB, which stays under Claude's 10 MB base64 limit.
  - Identical bytes get the same id, so attachments deduplicate.
  - Writes go to a temp file and are then renamed, so a crash never leaves a half-written image under a valid id.
  - Nothing deletes from the store. Deleting the original file, clearing the clipboard or restarting the app never breaks a chat.
- **Intake.** A pasted or dropped image is fitted by the composer, then uploaded to `POST /api/attachments`. A path goes to `POST /api/attachments/file`.
  - **The gate comes first.** Before it decodes anything, the composer asks `GET /api/attachments?check=1&chatId=…` whether the chat's model can read images. A refusal becomes the notice, and nothing is encoded or uploaded.
  - **Fitting** (`fitImage`, canvas): an image whose longest edge is over 2000 px, or whose size is over 7 MB, is downscaled to a 2000 px longest edge. An image the browser decodes but the providers don't take (BMP, AVIF, TIFF) is re-encoded even when it is within both limits. The format is sniffed from the bytes, not the file's type.
    - A JPEG source stays JPEG (quality 0.9).
    - Anything else is encoded as PNG and, when it has no transparency, as JPEG too; the smaller that fits wins. Screenshots usually stay PNG, photos become JPEG, and transparent images stay PNG.
    - JPEG at quality 0.75 on a white ground is the last resort.
    - A png, jpeg, gif or webp already within both limits uploads byte-for-byte. Only what still doesn't fit is refused, by the server. Full-screen Retina screenshots (5-15 MB) attach this way.
  - **Paths.** The server runs on the learner's machine, so it reads the path itself, asynchronously and capped at 64 MB, images only, sniffed. An image already within 7 MB and 2000 px is stored right there. A bigger one comes back as its bytes, and the composer fits and uploads it like a paste.
  - Accepted path forms: `~`, `file://`, quoted paths, and the `\ ` escapes a terminal drag produces.
  - The composer finds image paths in the message text at send time (`findImagePaths`). Each path that attaches is removed from the text, because the stored copy replaces it. A path that fails stays in the text as typed.
  - Every intake names its chat. The server refuses it before storing anything when that chat's model can't read images. The new-session page has no chat yet, so it gates on the strong slot the new chat is stamped from. Its images ride to the session's first send as `?images=<id>,…`.
  - When a send is refused and its text goes back into the composer, its image chips go back too.
- **The record keeps references only.** A user message carries `attachments: [{id, mimeType, name}]` next to its text, and attachments put no pixels into the chat JSON. (The older `read` tool still stores the base64 of any image file it reads; see below.)
  - `toLlmMessages`, the one model-facing seam, turns each reference into text: `[Image attached by the learner: <id> …]`.
  - It adds the pixels only for messages that come after the active compaction marker, and only when the live agent passes its store loader. The token estimate and the summarizer get references only.
  - Messages before the marker get the reference only. That includes the kept tail, which sits between `firstKeptMessageId` and the marker. Any image a tool returned inline there, such as the `read` tool's, is replaced by a short note.
  - **A per-request budget.** Each request carries at most 20 image blocks and about 20 MB of base64, newest first. Every image block counts: attachments, `view_image` results, and the images a tool result carries inline (the `read` tool's). Older stored images ride as reference text, and the model can call `view_image` for them; an older inline tool image becomes a note asking to read it again.
  - **One copy per stored image, where it first rode.** A stored image that appears several times (attached again, or viewed) carries its pixels at its first occurrence in the window, and the later ones are reference text. Pixels never move out of an earlier message, so the prefix stays byte-stable. The reason is Claude's limits: with more than 20 images in one request, every image must be under about 2000 px, and a request can be at most 32 MB. Compaction alone wouldn't prevent either: it triggers on tokens, and each image is estimated at only about 1,200 tokens.
  - The summarizer input lists each image's reference, and its prompt asks it to keep image ids exact. A summarized image therefore stays nameable.
- **`view_image`.**
  - The tool takes an attachment id only. It checks the id against `^[0-9a-f]{64}\.(png|jpg|gif|webp)$` before touching the store. No caller-supplied path is ever joined, so path traversal can't happen.
  - Its result records only `details.attachment`. The same wire rule adds the pixels, so reading an image again never puts pixels into the record.
  - The tool is armed for the prober, the teacher and practice through `AgentBuildOptions.attachments`.
- **Showing the image on the first turn.** The first request after attaching does include the image inline, and so does every later request until the next compaction. It is not sent only once.
  - Why: dropping the pixels after the first request would change an earlier message on every later request. That breaks the provider's prompt-cache prefix at that point. With the budget, the prefix changes only when the budget fills and the oldest image drops to a reference.
  - It is also what Claude Code does: the image stays in history until compaction.
  - The cost is that the base64 is resent each turn until compaction, which the Vision docs warn about.
  - After compaction, only references remain. The model calls `view_image` when it needs the pixels again.
- **Per-model support.**
  - The default is pi-ai's catalog metadata: `model.input.includes("image")`.
  - The `imageSupport` settings section stores overrides as `{provider: {modelId: boolean}}` in `settings.json`. You change them in Settings → Agent → Models → Image input, or with `PUT /api/settings/imageSupport`.
  - `/api/models` reports the effective value as `supportsImages`, and the vision-slot pickers filter on it.
  - The chat handler copies an override into the engine's Model (`withImageSupport`). Otherwise pi-ai's `downgradeUnsupportedImages` would replace the images with placeholder text.
  - Sends and steers that carry images refuse with `images_unsupported`. The composer shows the same words when you attach, so a refusal is never silent.
  - A send or steer refused that way (the model was switched after the image was attached) puts the text and the chips back in the composer, with the refusal as the notice.
  - The notice stays until the next intake or send, or until the chat's model, the strong slot or an image override changes.

## Default image support (v0.3.8 catalog)

Defaults come from pi-ai 1.4.0's catalog (`input`), cross-checked against the providers' own pages.

| Provider · model | Images | Source |
|---|---|---|
| anthropic · every model in the catalog: claude-fable-5, -5-1; claude-opus-4-5 … -5-5; claude-sonnet-4-5 … -5-5; claude-haiku-4-5, -5-5 (17 ids) | yes | pi-ai catalog; [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview): "All current models support text and image input" |
| openai · gpt-4 | no | pi-ai catalog; [GPT-4](https://developers.openai.com/api/docs/models/gpt-4): "Input modalities: text" |
| openai · o3-mini | no | pi-ai catalog; [o3-mini](https://developers.openai.com/api/docs/models/o3-mini): "Input modalities: text" |
| openai · every other catalog model (gpt-4-turbo, gpt-4.1*, gpt-4o*, gpt-5*, gpt-5.x*, gpt-6*, o1*, o3, o3-pro, o4-mini; 40 ids) | yes | pi-ai catalog; spot-checked: [gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5), [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): "Input modalities: text, image" |
| openai-codex · all 7 catalog models | yes | pi-ai catalog |
| chatgpt (subscription) · each model | same as the matching openai entry | `chatgpt-bridge.ts` copies the openai catalog entry, including `input` |
| github-copilot, xai subscriptions | the bridge's runtime model metadata | not checked here; the bridge supplies these models at runtime |
| openrouter · 401 models, 122 text-only | per catalog | pi-ai catalog; for example `anthropic/*` models are yes |
| claude-code (fork: the Claude subscription through Claude Code) · every model | yes | `claudeCodeCatalog` copies `input` from the anthropic catalog; [Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) lists "Image uploads" and shows base64 `image` blocks in `SDKUserMessage` content |

On the upstream base, "Claude" means the anthropic key or OpenRouter's `anthropic/*` models. The fork also has the claude-code provider (`src/agent/claude-code/`).

**The claude-code path carries images, checked by reading the code; e2e can't reach it.** The harness stubs OpenAI-compatible HTTP, and this provider spawns the local `claude` binary through the Agent SDK.
- `splitPrompt` (`history.ts`) turns the current turn's pi `image` blocks into base64 `image` prompt blocks.
- `streamClaudeCode` yields them in streaming-input mode, which supports images.
- `convertPiMessages` (`convert.ts`) keeps images in earlier user messages and in tool results, including `view_image` results, in the session file that the child resumes. `tests/claude-code-convert.test.ts` covers that conversion.
- The provider has no `downgradeUnsupportedImages` step, and its models declare `input: ["text", "image"]`.

## Known limits

- **Fitting needs the browser.** An image the browser can't decode (for example a HEIC file in Chrome) uploads as is, and the server refuses it unless it is a png, jpeg, gif or webp within 7 MB.
- **The first message needs text.** On the new-session page, the first message must have text; images ride along with it.
- **An image-only steer shows an empty line** in the queued-steer indicator until its card lands.
