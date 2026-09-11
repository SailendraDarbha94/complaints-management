import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DOCUMENT_CLASSES } from '@ksdc/contracts';
import { photograph, pickFile, readableSize, type CapturedFile } from '@/lib/capture';
import { fileDocument } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ink } from '@/lib/theme';

/**
 * Filing a document from the counter.
 *
 * For the OFFICER. A committee member cannot reach this screen and should not: evidence
 * entering the register from somebody whose job is to hear the case, outside the intake
 * process, is not a feature. The gate is the council_role claim, and the register would
 * refuse the write anyway.
 *
 * The screen is deliberately explicit about what happened to the bytes, because that is
 * the question somebody will ask about this document in two years and the answer should be
 * on the screen at the moment it is filed, not reconstructed afterwards.
 */

const CLASS_LABELS: Record<string, string> = {
  complaint_material: "The complainant's material",
  respondent_explanation: "The dentist's explanation",
  expert_report: 'Expert opinion',
  committee_record: 'Committee record',
  outbound_letter: 'Letter sent by the office',
  service_proof: 'Proof of service',
  legacy_register_extract: 'Extract from the paper register',
  other: 'Other',
};

export default function AddDocument() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { claims } = useSession();

  const [file, setFile] = useState<CapturedFile | null>(null);
  const [title, setTitle] = useState('');
  const [documentClass, setDocumentClass] = useState<string>('complaint_material');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (claims.councilRole !== 'officer') {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.refuse}>
          Only the Council office files documents. A committee member reads the file; they do
          not add to it.
        </Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </View>
    );
  }

  async function capture(fn: () => Promise<CapturedFile | null>) {
    setError(null);
    try {
      const got = await fn();
      if (!got) return; // backed out; not an error
      setFile(got);
      if (!title) setTitle('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function file_() {
    if (!file || !id) return;
    setBusy(true);
    setError(null);
    try {
      const out = await fileDocument(id, file, { title: title.trim(), documentClass }, setProgress);
      setDone(out.sha256);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.doneTitle}>Filed.</Text>
        <Text style={styles.doneBody}>
          The register identified the file by its own bytes and recorded this fingerprint:
        </Text>
        <Text style={styles.hash}>{done.slice(0, 32)}…</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Back to the case</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: insets.top + 10,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 18,
      }}
    >
      <Pressable onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.back}>‹ Case</Text>
      </Pressable>

      <Text style={styles.title}>Add a document</Text>

      {!file ? (
        <>
          <Text style={styles.label}>PHOTOGRAPH IT</Text>
          <Pressable style={styles.option} onPress={() => void capture(() => photograph('document'))}>
            <Text style={styles.optionTitle}>A document</Text>
            <Text style={styles.optionBody}>
              A bill, a prescription, a letter, an acknowledgement card. Photographed at about
              260 dpi across A4 — legible, and a few hundred kilobytes rather than four
              megabytes.
            </Text>
          </Pressable>

          <Pressable style={styles.option} onPress={() => void capture(() => photograph('clinical'))}>
            <Text style={styles.optionTitle}>A radiograph or clinical photograph</Text>
            <Text style={styles.optionBody}>
              Full resolution, no downscaling. Detail is the content here — this is what an
              expert opinion turns on, and a compression artefact at the apex of a root is not
              a cosmetic loss. It will be larger, and that is correct.
            </Text>
          </Pressable>

          <Text style={styles.label}>OR TAKE ONE FROM THIS PHONE</Text>
          <Pressable style={styles.option} onPress={() => void capture(pickFile)}>
            <Text style={styles.optionTitle}>Choose an existing file</Text>
            <Text style={styles.optionBody}>
              Stored exactly as it is, byte for byte. A file the Council was given is never
              altered — only a photograph the office takes itself has a resolution chosen for
              it.
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Image source={{ uri: file.uri }} style={styles.preview} resizeMode="contain" />

          <View style={styles.provenance}>
            <Text style={styles.provenanceText}>{file.provenance}</Text>
            <Text style={styles.provenanceSize}>
              {readableSize(file.sizeBytes)}
              {file.verbatim ? ' · unaltered' : ''}
            </Text>
          </View>

          <Text style={styles.label}>WHAT IS IT?</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Treatment bill, 3 February"
            placeholderTextColor={ink.faint}
            editable={!busy}
          />

          <Text style={styles.label}>WHERE DOES IT BELONG?</Text>
          <View style={styles.classes}>
            {DOCUMENT_CLASSES.map((c) => (
              <Pressable
                key={c}
                style={[styles.chip, documentClass === c && styles.chipOn]}
                onPress={() => setDocumentClass(c)}
                disabled={busy}
              >
                <Text style={[styles.chipText, documentClass === c && styles.chipTextOn]}>
                  {CLASS_LABELS[c] ?? c}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.file, (!title.trim() || busy) && styles.fileOff]}
            disabled={!title.trim() || busy}
            onPress={() => void file_()}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.fileText}>File it on the case</Text>
            )}
          </Pressable>

          {busy ? (
            <Text style={styles.progress}>
              {progress < 0.8 ? 'Uploading…' : 'Checking the file…'}
            </Text>
          ) : (
            <Pressable onPress={() => setFile(null)} disabled={busy}>
              <Text style={styles.link}>Take a different one</Text>
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, padding: 28, backgroundColor: ink.paper },
  back: { fontSize: 15, color: ink.stamp, marginBottom: 14 },
  title: { fontSize: 24, fontWeight: '600', color: ink.text, marginBottom: 6 },
  label: { fontSize: 11, letterSpacing: 0.9, color: ink.faint, marginTop: 24, marginBottom: 10, fontWeight: '600' },

  option: {
    backgroundColor: ink.surface,
    borderWidth: 1,
    borderColor: ink.rule,
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  optionTitle: { fontSize: 17, color: ink.text, fontWeight: '600' },
  optionBody: { fontSize: 13, color: ink.muted, lineHeight: 20, marginTop: 6 },

  preview: {
    width: '100%',
    height: 280,
    backgroundColor: ink.sunk,
    borderRadius: 10,
    marginTop: 10,
  },
  provenance: {
    backgroundColor: ink.stampSoft,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  provenanceText: { fontSize: 13, color: ink.stamp, lineHeight: 19 },
  provenanceSize: { fontSize: 12, color: ink.stamp, marginTop: 6, fontWeight: '600' },

  input: {
    borderWidth: 1,
    borderColor: ink.rule,
    borderRadius: 6,
    backgroundColor: ink.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: ink.text,
  },
  classes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: ink.rule,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ink.surface,
  },
  chipOn: { backgroundColor: ink.stamp, borderColor: ink.stamp },
  chipText: { fontSize: 13, color: ink.muted },
  chipTextOn: { color: '#fff', fontWeight: '600' },

  file: {
    marginTop: 24,
    backgroundColor: ink.stamp,
    borderRadius: 8,
    paddingVertical: 15,
    alignItems: 'center',
  },
  fileOff: { opacity: 0.4 },
  fileText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  progress: { textAlign: 'center', color: ink.faint, fontSize: 13, marginTop: 12 },

  error: { color: ink.seal, fontSize: 14, marginTop: 16, lineHeight: 20 },
  link: { fontSize: 15, color: ink.stamp, fontWeight: '600', marginTop: 18, textAlign: 'center' },
  refuse: { fontSize: 16, color: ink.muted, textAlign: 'center', lineHeight: 24 },
  doneTitle: { fontSize: 24, fontWeight: '600', color: ink.text },
  doneBody: { fontSize: 15, color: ink.muted, textAlign: 'center', lineHeight: 22 },
  hash: { fontSize: 13, color: ink.faint, letterSpacing: 0.5 },
});
