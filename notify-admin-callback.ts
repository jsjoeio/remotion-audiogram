/**
 * Optional POST to admin when public podcast AAC is ready (PREV-775).
 * Gradual rollout: missing ADMIN_PODCAST_CALLBACK_URL skips (not an error).
 */

export type AdminPodcastReadyPayload = {
  jobId: string | null;
  publicUrl: string;
  clientId: number | null;
  clientKey: string;
  clientFullName: string;
  podcastTitle: string;
  metaKey: string;
};

export async function notifyAdminPodcastReady(
  payload: AdminPodcastReadyPayload,
): Promise<void> {
  const url = process.env.ADMIN_PODCAST_CALLBACK_URL?.trim();
  if (!url) {
    console.info(
      "   Skipping admin podcast callback (ADMIN_PODCAST_CALLBACK_URL unset).",
    );
    return;
  }

  const token = process.env.ADMIN_PODCAST_CALLBACK_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "ADMIN_PODCAST_CALLBACK_URL is set but ADMIN_PODCAST_CALLBACK_TOKEN is missing.",
    );
  }

  console.log("\n\ud83d\udce1 POST admin podcast-ready callback");
  console.log(`   URL: ${url}`);
  console.log(`   jobId: ${payload.jobId ?? "(none)"}`);
  console.log(`   clientId: ${payload.clientId ?? "(none)"}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Admin podcast callback failed HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  console.log(`\u2705 Admin callback ok (HTTP ${res.status})`);
}
