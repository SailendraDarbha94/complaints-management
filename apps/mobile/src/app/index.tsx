import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';
import { listCases, type CaseRow } from '@/lib/cases';
import { ink } from '@/lib/theme';

/**
 * The cases in front of the committee.
 *
 * The design this came from organises the home screen around the next SITTING - the agenda
 * and nothing else - which is right, and is not buildable yet: there is no sitting in the
 * schema (build plan Phase 4). So this is the honest intermediate: every open case, newest
 * first. When sittings exist this screen becomes the agenda and this list moves behind it.
 *
 * A FlatList rather than a ScrollView, not for virtualisation - there are about ten cases,
 * ever - but for the free pull-to-refresh and because these are homogeneous rows.
 *
 * The bottom inset goes on contentContainerStyle, NOT on the view. Put it on the view and
 * the last card cannot scroll clear of the home indicator.
 */
export default function Index() {
  const { session, claims, loading, signOut } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCases(await listCases());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (session && claims.councilId) void load();
  }, [session, claims.councilId, load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (!session) return <Redirect href="/sign-in" />;

  // Signing in is not the same as being appointed, and the app says so rather than
  // showing an empty list that looks like a council with no complaints.
  if (!claims.councilId) {
    return (
      <SafeAreaView style={styles.center}>
        <View style={styles.notMember}>
          <Text style={styles.notMemberTitle}>Not an active member</Text>
          <Text style={styles.notMemberBody}>
            This account is not an active member of any council in the register. Ask the
            Registrar — signing in is not the same as being appointed.
          </Text>
          <Pressable onPress={() => void signOut()}>
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <FlatList
        data={cases ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 28, paddingHorizontal: 18 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.council}>KARNATAKA STATE DENTAL COUNCIL</Text>
            <Text style={styles.title}>Committee file</Text>
            <Text style={styles.subtitle}>
              {cases === null
                ? 'Loading…'
                : `${cases.length} open ${cases.length === 1 ? 'case' : 'cases'}`}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          cases === null ? (
            <ActivityIndicator style={{ marginTop: 40 }} />
          ) : (
            <Text style={styles.empty}>No open cases.</Text>
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={styles.confidential}>
              Confidential to the Council. Every document you open is logged, with your name
              and the time.
            </Text>
            <Pressable onPress={() => void signOut()}>
              <Text style={styles.link}>Sign out</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            onPress={() => router.push(`/case/${item.id}`)}
          >
            {item.on_hold ? (
              <Text style={styles.hold}>
                ON HOLD{item.hold_reason ? ` — ${item.hold_reason}` : ''}
              </Text>
            ) : null}
            {/* The grievance first and largest: it is what the member is here to read. The
                case number is a reference, not a headline, so it sits underneath. */}
            <Text style={styles.summary}>{item.summary}</Text>
            <Text style={styles.number}>{item.case_number}</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.paper },
  header: { paddingTop: 14, paddingBottom: 18 },
  council: { fontSize: 11, letterSpacing: 1.1, color: ink.faint },
  title: { fontSize: 26, fontWeight: '600', color: ink.text, marginTop: 6 },
  subtitle: { fontSize: 14, color: ink.muted, marginTop: 4 },
  card: {
    backgroundColor: ink.surface,
    borderWidth: 1,
    borderColor: ink.rule,
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  cardPressed: { backgroundColor: ink.sunk },
  hold: { fontSize: 11, letterSpacing: 0.6, color: ink.seal, marginBottom: 8, fontWeight: '600' },
  summary: { fontSize: 17, lineHeight: 24, color: ink.text },
  number: { fontSize: 12, color: ink.faint, marginTop: 10 },
  empty: { fontSize: 15, color: ink.muted, marginTop: 30, textAlign: 'center' },
  error: { fontSize: 13, color: ink.seal, marginTop: 12, lineHeight: 19 },
  footer: { marginTop: 22, gap: 16 },
  confidential: { fontSize: 12, color: ink.faint, lineHeight: 18 },
  link: { fontSize: 15, color: ink.stamp, fontWeight: '600' },
  notMember: { padding: 28, gap: 14 },
  notMemberTitle: { fontSize: 20, fontWeight: '600', color: ink.text },
  notMemberBody: { fontSize: 15, color: ink.muted, lineHeight: 22 },
});
