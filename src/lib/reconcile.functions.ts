import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AI_SYSTEM_PROMPT } from "./reconcile-prompt";

const filePartSchema = z.object({
  kind: z.enum(["image", "pdf", "text"]),
  name: z.string(),
  mimeType: z.string(),
  /** data URL for image/pdf, plain text for text */
  content: z.string(),
});

const inputSchema = z.object({
  scanned: filePartSchema,
  original: filePartSchema,
  excel: filePartSchema,
});

export type ReconcileFilePart = z.infer<typeof filePartSchema>;

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; filename: string; file_data: string };

function toParts(label: string, file: ReconcileFilePart): ContentPart[] {
  const header: ContentPart = {
    type: "input_text",
    text: `${label} — file name: ${file.name}`,
  };
  if (file.kind === "image") {
    return [header, { type: "input_image", image_url: file.content }];
  }
  if (file.kind === "pdf") {
    return [header, { type: "input_file", filename: file.name, file_data: file.content }];
  }
  return [header, { type: "input_text", text: file.content }];
}

export const runReconciliation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error("کلید OpenAI تنظیم نشده است.");
    }

    const content: ContentPart[] = [
      ...toParts("SCANNED_LIST", data.scanned),
      ...toParts("ORIGINAL_LIST", data.original),
      ...toParts("EXCEL_LIST", data.excel),
    ];

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [
          { role: "system", content: [{ type: "input_text", text: AI_SYSTEM_PROMPT }] },
          { role: "user", content },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${detail.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };

    const text =
      payload.output_text ??
      payload.output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("\n") ??
      "";

    if (!text.trim()) {
      throw new Error("مدل پاسخی تولید نکرد.");
    }

    return { html: stripCodeFence(text) };
  });

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}
