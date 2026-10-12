import { GoogleGenAI } from "@google/genai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { Router, type IRouter } from "express";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY must be set to use the chat endpoint.");
}

const gemini = new GoogleGenAI({ apiKey });
const router: IRouter = Router();

router.post("/chat/stream", async (req, res): Promise<void> => {
  const parsed = SendChatMessageBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid chat request." });
    return;
  }

  const messages = parsed.data.messages;
  const lastMessage = messages[messages.length - 1];
  const totalCharacters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );

  if (
    lastMessage?.role !== "user" ||
    !lastMessage.content.trim() ||
    totalCharacters > 24_000
  ) {
    res.status(400).json({
      error:
        "Send a user message and keep the conversation under 24,000 characters.",
    });
    return;
  }

  const generationController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      generationController.abort();
    }
  });

  try {
    const stream = await gemini.models.generateContentStream({
      model: "gemini-3-flash-preview",
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      config: {
        maxOutputTokens: 8192,
        abortSignal: generationController.signal,
        systemInstruction:
          "You are a helpful, thoughtful AI assistant. Give clear, direct answers and use readable formatting when it helps.",
      },
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    for await (const chunk of stream) {
      if (res.destroyed) {
        return;
      }

      const content = chunk.text;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!res.destroyed) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (error) {
    if (generationController.signal.aborted) {
      return;
    }

    const details =
      error instanceof Error
        ? error.message
            .replaceAll(apiKey, "[redacted]")
            .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
        : "Unknown Gemini error";
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    req.log.error(
      {
        provider: "gemini",
        errorName: error instanceof Error ? error.name : "UnknownError",
        status,
        details,
      },
      "Gemini chat request failed",
    );

    if (res.destroyed) {
      return;
    }

    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: "Gemini could not complete this reply. Try again." })}\n\n`,
      );
      res.end();
      return;
    }

    res.status(502).json({
      error: "Gemini could not complete this reply. Try again.",
    });
  }
});

export default router;
