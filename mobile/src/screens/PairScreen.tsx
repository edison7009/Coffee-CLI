import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parsePairingLink, RpcError, type PairingLink } from '../protocol';
import { useConnection } from '../connection';
import { t } from '../i18n';
import { useTheme } from '../theme';

const DEFAULT_NAME = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android' : 'Browser';

export function PairScreen() {
  const theme = useTheme();
  const { pair } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [link, setLink] = useState('');
  const [name, setName] = useState(DEFAULT_NAME);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (text: string) => {
    if (waiting) return;
    let parsed: PairingLink;
    try { parsed = parsePairingLink(text); } catch { setError(t('pair.invalid')); return; }
    setWaiting(true); setError('');
    try { await pair(parsed, name.trim() || DEFAULT_NAME); }
    catch (e) { setError(t(e instanceof RpcError && e.code === 'unauthorized' ? 'error.unauthorized' : 'error.unreachable')); }
    finally { setWaiting(false); }
  };

  const camera = Platform.OS !== 'web';
  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: theme.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>{t('pair.title')}</Text>
        <Text style={[styles.body, { color: theme.muted }]}>{t('pair.steps')}</Text>

        {camera && <View style={[styles.cameraBox, { borderColor: theme.border, backgroundColor: theme.card }]}>
          {permission?.granted && !waiting
            ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => void submit(data)} />
            : <View style={styles.cameraPlaceholder}>
              <Text style={[styles.body, { color: theme.muted, textAlign: 'center' }]}>{permission && !permission.canAskAgain ? t('pair.camera_denied') : t('pair.scan')}</Text>
              {!permission?.granted && permission?.canAskAgain !== false && <Pressable accessibilityRole="button" style={[styles.button, { backgroundColor: theme.accent }]} onPress={() => void requestPermission()}><Text style={[styles.buttonText, { color: theme.accentText }]}>{t('pair.camera_allow')}</Text></Pressable>}
            </View>}
        </View>}

        <Text style={[styles.label, { color: theme.muted }]}>{t('pair.device_name')}</Text>
        <TextInput value={name} onChangeText={setName} maxLength={64} style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]} />

        <Text style={[styles.label, { color: theme.muted }]}>{t('pair.paste')}</Text>
        <TextInput value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} placeholder="coffee://pair?…" placeholderTextColor={theme.muted} style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]} />
        <Pressable accessibilityRole="button" disabled={waiting || !link.trim()} style={[styles.button, { backgroundColor: theme.accent, opacity: waiting || !link.trim() ? 0.5 : 1 }]} onPress={() => void submit(link)}>
          <Text style={[styles.buttonText, { color: theme.accentText }]}>{t('pair.connect')}</Text>
        </Pressable>

        {waiting && <View style={styles.row}><ActivityIndicator color={theme.accent} /><Text style={[styles.body, { color: theme.text }]}>{t('pair.waiting')}</Text></View>}
        {!!error && <Text accessibilityRole="alert" style={[styles.body, { color: theme.danger }]}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 72, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontSize: 13, marginTop: 8 },
  cameraBox: { height: 280, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginVertical: 8 },
  cameraPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  button: { borderRadius: 12, paddingVertical: 13, paddingHorizontal: 20, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
