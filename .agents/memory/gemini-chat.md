---
name: Gemini chat
description: Project-specific Gemini credential preference and model-availability lessons.
---

This app uses a user-supplied Gemini API key stored in Replit Secrets, not Replit-managed AI credits. Keep Gemini requests on the API server and never expose the key in the browser or logs.

On October 12, 2026, `gemini-2.5-flash` was unavailable to new API-key users, `gemini-3.8-flash` returned a temporary 503 high-demand error, and `gemini-3-flash-preview` completed a live request successfully.

**Why:** the user explicitly asked to use their own Gemini key, and live testing showed model availability and capacity can vary independently of whether the key is valid.

**How to apply:** When changing or upgrading the model, keep credentials server-side, test a small live request, and prefer a supported model that responds successfully.
