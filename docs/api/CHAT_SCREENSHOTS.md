# Chat screenshots

In Chat (`/playground`), **Screenshot** opens the browser's source picker:

- **Entire screen** includes the desktop and all visible windows on one monitor.
- **Window** captures the selected application window.
- **Browser tab** captures the selected tab, including the current tab.

Agent X requests all source types without preferring one. Available choices
depend on the browser. The preview labels the actual chosen source when the
browser reports it. It does not stitch multiple monitors or scroll a web page.
Agent X captures one visible frame without audio, stops every media
track immediately, and shows a removable preview. This requires a supported
desktop browser over HTTPS or localhost. **More conversation tools → Attach
screenshot file**, or pasting an image into the composer, provides a fallback.

Add a question and press **Send**. Capture/selection alone sends nothing to
the server. One screenshot accompanies each user message. Images are resized
to a maximum edge of 1920 pixels and encoded as JPEG. The image stays with its
conversation after reload, failure, Stop, Retry, and Ask again. Edit restores
the image to the composer; New chat clears the draft.

The exact selected Ollama model must advertise `vision` in `/api/show`.
Otherwise the chat explains that a model with vision must be selected in
Manual controls. This applies to images in conversation history too; the
service never silently omits them. Existing model routing and context limits
remain authoritative. Captures are not ingested into RAG.

## API

- `POST /api/chat/images` accepts `{ dataUrl }` (PNG/JPEG, up to 2 MiB of
  decoded bytes), returning `{ status: "success", data: { id } }` with HTTP 201.
- `GET /api/chat/images/:id` returns the image bytes with their content type.
- `POST /api/chat` and `POST /api/chat/stream` accept `imageIds: [id]` for the
  current turn. Historical user entries in `messages` can carry the same field.
- The failed/stopped turn API (`POST /api/history/turn-outcome`) also accepts
  `imageIds`, preserving the attachment for a retry after reload.

Image bytes live in `ChatImage` documents, with small references on user
messages, so history lists and Conversation documents do not accumulate image
payloads. Deleting a conversation removes images no longer referenced by any
other conversation. Uploads that never reach a saved turn remain in ChatImage;
there is no automatic retention policy for these uploads in this version.

Native Ollama inference receives base64 image bytes in `messages[].images`,
along with the original text and conversation context. Transport/storage tests
use disposable MongoDB and a stubbed model; actual model interpretation and
the native browser picker require acceptance in the target environment.

API references: [browser screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
and [Ollama vision messages](https://docs.ollama.com/capabilities/vision).
