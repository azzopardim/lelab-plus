import type { Fetcher } from "./apiClient";
import type { JogArm } from "./jogControls";

/** Hold-to-move target for one arm; `null` releases it immediately. */
export async function sendJogTarget(
  baseUrl: string,
  fetcher: Fetcher,
  arm: JogArm,
  joints: Record<string, number> | null,
): Promise<{ success: boolean; message?: string }> {
  const res = await fetcher(`${baseUrl}/jog-target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arm, joints }),
  });
  return res.json();
}
