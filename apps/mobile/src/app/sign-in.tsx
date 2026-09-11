import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';

/**
 * Signing in.
 *
 * Email and password, matching the web - the council chose that over the passwordless
 * code, and two sign-in models for one register would be two things to explain and two
 * things to break.
 *
 * THERE IS NO SIGN-UP, and no link to one. Officers and committee members are appointed;
 * an account exists because somebody with authority created it. The council's Supabase
 * project has sign-ups disabled at the project level too, so this is the second of two
 * locks rather than the only one.
 */
export default function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = email.includes('@') && password.length >= 10 && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.council}>KARNATAKA STATE DENTAL COUNCIL</Text>
          <Text style={styles.title}>Complaints Register</Text>

          <Text style={styles.label}>Your council email address</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="username"
            keyboardType="email-address"
            inputMode="email"
            placeholder="officer@ksdc.in"
            editable={!busy}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            editable={!busy}
            onSubmitEditing={() => ready && submit()}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, !ready && styles.buttonDisabled]}
            disabled={!ready}
            onPress={submit}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>

          <Text style={styles.note}>
            Accounts are created by the Registrar. If you do not have one, ask the office —
            there is no way to sign yourself up, by design.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f5f2' },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, maxWidth: 480, width: '100%', alignSelf: 'center' },
  council: { fontSize: 11, letterSpacing: 1.2, color: '#767d8e', marginBottom: 6 },
  title: { fontSize: 26, fontWeight: '600', color: '#191e2b', marginBottom: 32 },
  label: { fontSize: 12, fontWeight: '600', color: '#4a5163', marginBottom: 6, marginTop: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#d8d5cd',
    borderRadius: 6,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#191e2b',
  },
  button: {
    marginTop: 26,
    backgroundColor: '#2f3e8c',
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { marginTop: 14, color: '#a82820', fontSize: 14 },
  note: { marginTop: 22, color: '#767d8e', fontSize: 13, lineHeight: 19 },
});
