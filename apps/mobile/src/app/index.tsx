import { Redirect } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ROLES } from '@ksdc/contracts';
import { useSession } from '@/lib/session';

/**
 * What a signed-in member sees.
 *
 * Almost nothing yet, deliberately. The register's tables are not granted to the
 * `authenticated` role - no policy, no grant, nothing readable from a phone - so this
 * cannot list case files however much it would like to. That is the correct order: the
 * policies that decide which rows a member may see are written one table at a time, as
 * deliberate reviewed decisions, not as a default switched on to make a screen work.
 *
 * What it does prove is the part that had to come first. The account signs in, Supabase
 * mints a token, the access token hook puts the council and the role into it, and the
 * phone reads them back. Everything after this is a query away.
 */
export default function Index() {
  const { session, claims, loading, signOut } = useSession();

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (!session) return <Redirect href="/sign-in" />;

  const roleLabel: Record<(typeof ROLES)[number], string> = {
    officer: 'Dental Officer',
    committee_member: 'Committee member',
    auditor: 'Auditor',
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.council}>KARNATAKA STATE DENTAL COUNCIL</Text>
        <Text style={styles.title}>Signed in</Text>

        <View style={styles.card}>
          <Text style={styles.label}>ACCOUNT</Text>
          <Text style={styles.value}>{session.user.email}</Text>

          <Text style={styles.label}>ROLE</Text>
          <Text style={styles.value}>
            {claims.councilRole ? roleLabel[claims.councilRole] : 'None recorded'}
          </Text>

          <Text style={styles.label}>COUNCIL</Text>
          <Text style={[styles.value, styles.mono]}>{claims.councilId ?? 'None'}</Text>
        </View>

        {claims.councilId ? (
          <Text style={styles.note}>
            The council and role above came from the access token, put there by the register
            when Supabase issued it. Case files are not readable from a phone yet: the
            row-level security policies for this app are written one table at a time, and
            none has been granted.
          </Text>
        ) : (
          <Text style={styles.warn}>
            This account is not an active member of any council in the register. Ask the
            Registrar — signing in is not the same as being appointed.
          </Text>
        )}

        <Pressable style={styles.signOut} onPress={() => void signOut()}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f5f2' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f6f5f2' },
  body: { padding: 24, maxWidth: 560, width: '100%', alignSelf: 'center' },
  council: { fontSize: 11, letterSpacing: 1.2, color: '#767d8e', marginBottom: 6 },
  title: { fontSize: 24, fontWeight: '600', color: '#191e2b', marginBottom: 22 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d8d5cd',
    borderRadius: 8,
    padding: 16,
  },
  label: { fontSize: 10, letterSpacing: 0.8, color: '#767d8e', marginTop: 12 },
  value: { fontSize: 16, color: '#191e2b', marginTop: 3 },
  mono: { fontFamily: undefined, fontSize: 13, color: '#4a5163' },
  note: { marginTop: 20, color: '#4a5163', fontSize: 13, lineHeight: 20 },
  warn: { marginTop: 20, color: '#a82820', fontSize: 14, lineHeight: 21 },
  signOut: { marginTop: 28, alignSelf: 'flex-start' },
  signOutText: { color: '#2f3e8c', fontSize: 15, fontWeight: '600' },
});
