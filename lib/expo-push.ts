import { Expo, type ExpoPushMessage } from "expo-server-sdk";

const expo = new Expo();

export async function sendPushNotifications(
  tokens: string[],
  title: string,
  body: string
) {
  const messages: ExpoPushMessage[] = tokens
    .filter((token) => Expo.isExpoPushToken(token))
    .map((token) => ({
      to: token,
      sound: "default" as const,
      title,
      body,
    }));

  if (messages.length === 0) {
    return { sent: 0, errors: [] };
  }

  const chunks = expo.chunkPushNotifications(messages);
  const errors: string[] = [];
  let sent = 0;

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of ticketChunk) {
        if (ticket.status === "ok") {
          sent++;
        } else if (ticket.status === "error") {
          errors.push(ticket.message || "Unknown error");
        }
      }
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "Failed to send chunk"
      );
    }
  }

  return { sent, errors };
}
