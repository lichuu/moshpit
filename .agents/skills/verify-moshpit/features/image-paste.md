# Image upload

The Chat and Terminal composers accept one PNG, JPEG, WebP, or GIF up to 10 MB through the file picker, clipboard paste, or drag-and-drop. They show a thumbnail and keep the image and message until delivery succeeds.

## Sub-features

- Paperclip opens the image picker. Pasting or dropping an image uses the same attachment path.
- An image pasted while the Terminal pane is focused or dropped elsewhere in Terminal appears in its composer. The image stays unsent until Send. Text paste into the pane keeps its existing behavior.
- The thumbnail shows the selected file. Remove cancels it.
- Send supports an image with or without text. Pending sends disable duplicate submissions.
- The browser sends actual bytes to the paired bridge. The bridge checks size and image signatures, writes a private file in its uploads directory, and includes the host path in the agent prompt.
- Terminal preserves literal text and sends the image path with a separate Enter. An image-only send adds `Please inspect this image.` before the path.
- Rejected or failed sends keep the draft and image for retry.
- Uploaded images render inline in native chat history. Tap one to open it full-size. Previews survive reload because the bridge serves the saved image with the same authentication as session history. Missing files show "Image unavailable".
- Only files in the bridge uploads directory can be previewed. Arbitrary local paths and remote Markdown images are not fetched.

## How to get to it (user POV)

- Open an agent, then choose Chat or Terminal.
- Attach, paste, or drop an image into the composer. In Terminal, you can also paste into the focused pane or drop elsewhere in the view.
- Review the thumbnail and choose Send.

## Driving it with drive.mjs

This feature uses dedicated checks:

- `npm run verify:upload` builds the PWA and drives an isolated bridge with a demo backend. It checks unpaired rejection, invalid and oversized files, exact saved bytes, file permissions, the prompt path, retry, paste, drop, and image-only sends.
- `npm run verify:chat-upload` sends an image through the native submission path using an isolated fixture agent. It checks inline rendering, opening, reload, missing files, authenticated reads, and path traversal rejection.
- `MOSHPIT_TEST_PORT=4197 MOSHPIT_DEV_PORT=5197 npx playwright test tests/bridge/terminal-typing.spec.ts --project=phone --project=desktop --output=/tmp/moshpit-terminal-image-results --reporter=list` checks Terminal uploads through isolated bridges. It verifies exact bytes and permissions, text and path followed by Enter, picker, composer and pane paste, body paste, drop, removal, image-only sends, and failure with retry. It also checks focus, attachment protection during delivery, and isolation between agent sessions and Chat.
- `npm run verify:pwa` checks thumbnail and send-button layout across all tested browser engines and viewport sizes.
- `node helpers/check-image-paste.mjs <port> [screenshot]` retains the local demo attachment scenario.

## Gotchas

- IndexedDB saves draft text and the image File, scoped to the host, agent session, and composer view.
- Uploads remain under the bridge's state directory so agents can read them. The agent must have file access on that host.
- The test backend proves file delivery and prompt construction, not a model's interpretation of an image.
- Clipboard and drop checks dispatch browser events; a physical camera and OS clipboard remain device checks.
