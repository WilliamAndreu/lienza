export async function readApi<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Error HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
