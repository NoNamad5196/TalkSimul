export async function apiPost<T>(
  route: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(45000);
  const response = await fetch(`/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "서버 응답을 읽지 못했어요. 인터넷 연결을 확인하거나 잠시 후 다시 시도해 주세요.",
    );
  }
  if (!response.ok)
    throw new Error(
      data.error || "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  return data as T;
}
