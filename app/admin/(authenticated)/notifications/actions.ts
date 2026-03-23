"use server";

import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { sendPushNotifications } from "@/lib/expo-push";

const notificationSchema = z.object({
  title: z.string().min(1, "Title is required").max(100),
  body: z.string().min(1, "Message is required").max(500),
  target: z.enum(["all", "user"]),
  userId: z.string().optional(),
});

export type NotificationState = {
  success?: string;
  error?: string;
  fieldErrors?: {
    title?: string[];
    body?: string[];
    userId?: string[];
  };
};

export async function sendNotification(
  _prevState: NotificationState,
  formData: FormData
): Promise<NotificationState> {
  const raw = {
    title: formData.get("title"),
    body: formData.get("body"),
    target: formData.get("target"),
    userId: formData.get("userId") || undefined,
  };

  const parsed = notificationSchema.safeParse(raw);

  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createServiceClient();
  let tokens: string[] = [];

  if (parsed.data.target === "all") {
    // Fetch all push tokens
    const { data } = await supabase
      .from("push_tokens")
      .select("token");
    tokens = data?.map((d) => d.token) || [];
  } else if (parsed.data.userId) {
    // Fetch token for specific user
    const { data } = await supabase
      .from("push_tokens")
      .select("token")
      .eq("user_id", parsed.data.userId);
    tokens = data?.map((d) => d.token) || [];
  }

  if (tokens.length === 0) {
    return {
      error:
        "No push tokens found. Make sure users have registered their devices.",
    };
  }

  const result = await sendPushNotifications(
    tokens,
    parsed.data.title,
    parsed.data.body
  );

  if (result.errors.length > 0) {
    return {
      error: `Sent ${result.sent} notifications, but ${result.errors.length} failed: ${result.errors[0]}`,
    };
  }

  return {
    success: `Successfully sent ${result.sent} push notification${result.sent !== 1 ? "s" : ""}`,
  };
}

export async function searchUsers(query: string) {
  if (!query || query.length < 2) return [];

  const supabase = await createServiceClient();
  const { data } = await supabase
    .from("users_master")
    .select("id, full_name, email")
    .or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
    .limit(10);

  return data || [];
}
