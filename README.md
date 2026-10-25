# Ollama #1

Processing server for one signed-in Ollama user. It accepts only `:cloud` models and keeps five user slots.

The Ollama daemon and the processing server run in the same container. Sign in once with your Ollama user. Prompts from the five slots then go through that login to Ollama Cloud. The raw Ollama port is not published.

## Slots

`POST /v1/sessions` with `Authorization: Bearer <gate token>` takes one of five slots. A slot drops after 15 minutes without a prompt. `POST /v1/chat` needs the same bearer token plus `X-Session`.

`POST /v1/signin` starts `ollama signin` and returns the URL to approve with your Ollama user. Open `/` in a browser for the same actions.

`GET /health` is unauthenticated so the platform can probe the process. It does not show whether anyone is signed in.
