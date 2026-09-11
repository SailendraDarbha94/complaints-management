import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '@/lib/session';

/**
 * The shell.
 *
 * A stack, not tabs. There is one thing a committee member does on a phone - read the
 * case files for the sitting they are about to attend - and a tab bar would be three
 * empty rooms around it. Tabs can come back when there is a second thing.
 */
export default function RootLayout() {
  const scheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="sign-in" />
          </Stack>
        </ThemeProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
