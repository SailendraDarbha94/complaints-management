import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import {
  getCase,
  gapMonths,
  isReconstructed,
  milestoneWords,
  respondentPosition,
  shortDate,
  type CaseFile,
} from '@/lib/cases';
import { ink } from '@/lib/theme';

/**
 * One case file. The photocopied bundle, better ordered.
 *
 * One ScrollView, no tabs, no accordions. The content is heterogeneous and there are
 * perhaps thirty children; a FlatList would buy nothing and cost the scroll restoration.
 *
 * ORDER IS THE DESIGN. Top to bottom: what the sitting must decide, what the case is
 * about, who is involved, where each dentist stands, the papers, and last and quietest,
 * how it got here. Putting the timeline at the top is the commonest way a case file stops
 * answering "why am I looking at this" in the first three seconds.
 *
 * Screen capture is blocked while this is mounted. A member's own phone is where a
 * complaint is most likely to leave the Council's control, and this is the one mitigation
 * that costs nothing. It is a real block on Android and a notification on iOS.
 */
export default function CaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [data, setData] = useState<CaseFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ScreenCapture.preventScreenCaptureAsync();
    return () => {
      void ScreenCapture.allowScreenCaptureAsync();
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    getCase(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const { file, parties, respondents, milestones, documents } = data;

  const complainant = parties.find((p) => p.role === 'complainant');
  const patient = parties.find((p) => p.role === 'patient');
  const patientIsSomeoneElse =
    patient && patient.party?.full_name !== complainant?.party?.full_name;

  // Any reconstructed date on the file gets one footnote, not one per line.
  const anyReconstructed = milestones.some((m) => isReconstructed(m.date_source));

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 18,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Cases</Text>
        </Pressable>

        {/* 1. On hold, above everything. A listed case that is on hold changes what the
            sitting can do at all. */}
        {file.on_hold ? (
          <View style={styles.holdBand}>
            <Text style={styles.holdText}>
              On hold{file.held_since ? ` since ${shortDate(file.held_since)}` : ''}
              {file.hold_reason ? ` — ${file.hold_reason}` : ''}
            </Text>
          </View>
        ) : null}

        {/* 2. THE QUESTION. There is no field for it yet, and the design is explicit that
            the app must NOT guess one from the case state - a templated sentence at the
            head of a quasi-judicial file frames the case before the member reads a word. */}
        <View style={styles.askBlock}>
          <Text style={styles.askMissing}>
            The office has not recorded what this sitting is to decide.
          </Text>
        </View>

        {/* 3. What it is about - the officer's own words, never truncated. */}
        <Text style={styles.label}>WHAT IT IS ABOUT</Text>
        <Text style={styles.summary}>{file.summary}</Text>
        <Text style={styles.caseNumber}>
          {file.case_number}
          {file.is_backfilled ? '  ·  entered from the paper register' : ''}
        </Text>

        {/* 4. Who. */}
        <Text style={styles.label}>WHO</Text>
        <Text style={styles.person}>
          {complainant?.party?.full_name ?? 'Not recorded'}
          <Text style={styles.role}>  complainant</Text>
        </Text>
        {patientIsSomeoneElse ? (
          <Text style={styles.person}>
            {patient?.party?.full_name}
            <Text style={styles.role}>
              {'  patient'}
              {patient?.party?.age_years ? `, ${patient.party.age_years}` : ''}
              {patient?.party?.sex ? `, ${patient.party.sex === 'F' ? 'female' : 'male'}` : ''}
            </Text>
          </Text>
        ) : null}

        {/* Each respondent's own position, as a sentence. Their outcomes are independent,
            so they get separate blocks. */}
        {respondents.length > 0 ? (
          <>
            <Text style={styles.label}>
              {respondents.length === 1 ? 'THE DENTIST' : 'THE DENTISTS'}
            </Text>
            {respondents.map((r, i) => (
              <View key={r.id} style={[styles.respondent, i > 0 && styles.respondentDivided]}>
                <Text style={styles.person}>
                  {r.case_party?.party?.full_name ?? 'Not recorded'}
                </Text>
                <Text style={styles.position}>{respondentPosition(r)}</Text>
                {r.notice_count > 0 && !r.first_reply_at ? (
                  <Text style={styles.practice}>
                    The Council's practice is three notices before proceeding ex parte.
                    {' '}
                    {r.notice_count === 1 ? 'One has' : `${r.notice_count} have`} been despatched.
                  </Text>
                ) : null}
              </View>
            ))}
          </>
        ) : null}

        {/* 6-8. The papers. An absence here is itself a finding and must not be blank. */}
        <Text style={styles.label}>THE PAPERS</Text>
        {documents.length === 0 ? (
          <Text style={styles.absent}>Nothing has been filed on this case yet.</Text>
        ) : (
          documents.map((d) => (
            <View key={d.id} style={styles.paper}>
              <Text style={styles.paperTitle}>{d.title}</Text>
              <Text style={styles.paperMeta}>{d.document_class.replace(/_/g, ' ')}</Text>
            </View>
          ))
        )}

        {/* 9. How it got here. Last, and deliberately the quietest thing on the screen. */}
        {milestones.length > 0 ? (
          <>
            <Text style={styles.label}>HOW IT GOT HERE</Text>
            {milestones.map((m, i) => {
              const gap = i > 0 ? gapMonths(milestones[i - 1]!.occurred_at, m.occurred_at) : 0;
              return (
                <View key={m.id}>
                  {gap > 0 ? (
                    // The questions a committee asks are usually about the silences.
                    <Text style={styles.gap}>· {gap} months ·</Text>
                  ) : null}
                  <View style={styles.event}>
                    <Text style={styles.eventDate}>
                      {shortDate(m.occurred_at)}
                      {isReconstructed(m.date_source) ? '†' : ''}
                    </Text>
                    <Text style={styles.eventText}>{milestoneWords(m.milestone)}</Text>
                  </View>
                </View>
              );
            })}
            {anyReconstructed ? (
              <Text style={styles.footnote}>
                † reconstructed from the paper register, not recorded when it happened.
              </Text>
            ) : null}
          </>
        ) : null}

        <Text style={styles.confidential}>
          Confidential to the Council. Every document you open is logged, with your name and
          the time.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24, backgroundColor: ink.paper },
  back: { fontSize: 15, color: ink.stamp, marginBottom: 16 },

  holdBand: {
    backgroundColor: ink.sealSoft,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  holdText: { color: ink.seal, fontSize: 14, fontWeight: '600', lineHeight: 20 },

  askBlock: {
    borderLeftWidth: 3,
    borderLeftColor: ink.rule,
    paddingLeft: 14,
    paddingVertical: 4,
    marginBottom: 8,
  },
  askMissing: { fontSize: 17, color: ink.faint, lineHeight: 24, fontStyle: 'italic' },

  label: {
    fontSize: 11,
    letterSpacing: 0.9,
    color: ink.faint,
    marginTop: 28,
    marginBottom: 8,
    fontWeight: '600',
  },
  summary: { fontSize: 18, lineHeight: 26, color: ink.text },
  caseNumber: { fontSize: 12, color: ink.faint, marginTop: 10 },

  person: { fontSize: 17, color: ink.text, marginTop: 6, lineHeight: 24 },
  role: { fontSize: 13, color: ink.faint },

  respondent: { marginTop: 10 },
  respondentDivided: { borderTopWidth: 1, borderTopColor: ink.ruleSoft, paddingTop: 14, marginTop: 14 },
  position: { fontSize: 15, color: ink.muted, marginTop: 4, lineHeight: 22 },
  practice: { fontSize: 13, color: ink.faint, marginTop: 8, lineHeight: 19 },

  absent: { fontSize: 15, color: ink.faint, lineHeight: 22 },
  paper: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: ink.ruleSoft },
  paperTitle: { fontSize: 16, color: ink.text },
  paperMeta: { fontSize: 12, color: ink.faint, marginTop: 3 },

  gap: { fontSize: 12, color: ink.faint, marginVertical: 8, marginLeft: 96 },
  event: { flexDirection: 'row', paddingVertical: 5 },
  eventDate: { width: 92, fontSize: 13, color: ink.faint },
  eventText: { flex: 1, fontSize: 14, color: ink.muted, lineHeight: 20 },
  footnote: { fontSize: 12, color: ink.faint, marginTop: 12, lineHeight: 18 },

  confidential: { fontSize: 12, color: ink.faint, marginTop: 34, lineHeight: 18 },
  error: { fontSize: 15, color: ink.seal, textAlign: 'center', lineHeight: 22 },
  link: { fontSize: 15, color: ink.stamp, fontWeight: '600' },
});
