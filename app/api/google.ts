import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const bearToken =
    req.headers.get("x-goog-api-key") || req.headers.get("Authorization") || "";
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();

  const apiKey = token ? token : serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: true,
        message: `missing GOOGLE_API_KEY in server env vars`,
      },
      {
        status: 401,
      },
    );
  }
  try {
    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(req: NextRequest, apiKey: string) {
  const controller = new AbortController();

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  const fetchUrl = `${baseUrl}${path}${
    req?.nextUrl?.searchParams?.get("alt") === "sse" ? "?alt=sse" : ""
  }`;

  console.log("[Fetch Url] ", fetchUrl);
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // 添加一个两秒的心跳，防止流式一直不出结果
  let intervalId: any;
  let responseStream: ReadableStream;
  const transformStream = new TransformStream();
  const writer = transformStream.writable.getWriter();
  const encoder = new TextEncoder();

  // 启动一个心跳定时器，每 2 秒发送一个 SSE 注释，以保持连接活跃
  intervalId = setInterval(() => {
    writer.write(encoder.encode("Waiting...\n"));
    console.log("[Google] Sent keep-alive");
  }, 2000);

  // 异步执行 AI 调用
  (async () => {
    try {
      const res = await fetch(fetchUrl, fetchOptions);
      // to prevent browser prompt for credentials
      const newHeaders = new Headers(res.headers);
      newHeaders.delete("www-authenticate");
      // to disable nginx buffering
      newHeaders.set("X-Accel-Buffering", "no");
  
      // 当收到第一个数据块时，清除心跳定时器
      let isFirstChunk = true;
      for await (const chunk of res.body as any) {
        if (isFirstChunk) {
          clearInterval(intervalId);
          isFirstChunk = false;
          console.log("[Google] First chunk received, clearing keep-alive interval.");
        }
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          // 将 AI 的真实数据写入流
          // 注意：这里我们直接写入原始 SSE 格式的 chunk
          // 如果你使用 'ai' 包的 OpenAIStream，逻辑会略有不同
          // 这里为了演示，我们假设直接代理 SSE 文本
          writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
      }
    } finally {
      clearTimeout(timeoutId);
      // 确保在任何情况下都清除定时器并关闭流
      if (intervalId) {
        clearInterval(intervalId);
        console.log("[Google] Stream ended, clearing interval.");
      }
      writer.close();
    }
  })();

  // 使用 transformStream.readable 作为响应体
  responseStream = transformStream.readable;

  return new Response(responseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });

  // try {
  //   const res = await fetch(fetchUrl, fetchOptions);
  //   // to prevent browser prompt for credentials
  //   const newHeaders = new Headers(res.headers);
  //   newHeaders.delete("www-authenticate");
  //   // to disable nginx buffering
  //   newHeaders.set("X-Accel-Buffering", "no");

  //   return new Response(res.body, {
  //     status: res.status,
  //     statusText: res.statusText,
  //     headers: newHeaders,
  //   });
  // } finally {
  //   clearTimeout(timeoutId);
  // }
}
