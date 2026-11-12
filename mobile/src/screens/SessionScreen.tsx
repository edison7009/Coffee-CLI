import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useConnection } from '../connection';
import { applyEvent, emptyConversation, isBusy, rows, title, type ConversationState, type Kind, type Row } from '../conversation';
import { t } from '../i18n';
import { useTheme, type Theme } from '../theme';
import type { SessionInfo } from './SessionsScreen';

const TERMINAL_LIMIT = 200_000;
// Colours, cursor moves and title sequences have no meaning in a plain text view.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b[@-Z\\-_]/g;
const stripAnsi = (text: string) => text.replace(ANSI, '').replace(/\r(?!\n)/g, '');

interface Subscribe { view: 'conversation' | 'terminal' | null; kind?: Kind; generation?: string; events?: Record<string, unknown>[]; snapshot?: string }

export function SessionScreen({ session, onBack }: { session: SessionInfo; onBack(): void }) {
  const theme = useTheme();
  const { client } = useConnection();
  const kind = (session.kind ?? null) as Kind | null;
  const [conversation, setConversation] = useState<ConversationState | null>(kind ? emptyConversation(kind) : null);
  const [terminal, setTerminal] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const generation = useRef<string | null>(null);

  // Subscribe (again after every reconnect or resync) and follow live events.
  useEffect(() => {
    if (!client) return;
    let live = true;
    const subscribe = async () => {
      try {
        const replay = await client.request<Subscribe>('session.subscribe', { id: session.id });
        if (!live) return;
        if (replay.view === 'conversation' && replay.kind) {
          generation.current = replay.generation ?? null;
          setConversation((replay.events ?? []).reduce(applyEvent, emptyConversation(replay.kind)));
        } else if (replay.view === 'terminal') setTerminal(stripAnsi(replay.snapshot ?? '').slice(-TERMINAL_LIMIT));
      } catch { /* the connection banner explains */ }
    };
    const stop = client.onEvent(({ event, params }) => {
      if (params.id !== session.id) return;
      if (event === 'conversation.event') {
        const next = params as { kind: Kind; generation: string; payload: Record<string, unknown> };
        setConversation(current => {
          // A restarted session starts its reducer state over.
          const base = !current || current.kind !== next.kind || generation.current !== next.generation ? emptyConversation(next.kind) : current;
          generation.current = next.generation;
          return applyEvent(base, next.payload);
        });
      } else if (event === 'terminal.output') setTerminal(text => (text + stripAnsi(String(params.data ?? ''))).slice(-TERMINAL_LIMIT));
      else if (event === 'terminal.resync') void subscribe();
    });
    void subscribe();
    return () => { live = false; stop(); void client.request('session.unsubscribe', { id: session.id }).catch(() => {}); };
  }, [client, session.id]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !client) return;
    setError('');
    try {
      if (conversation) await client.request('conversation.send', { id: session.id, text });
      else await client.request('session.input', { id: session.id, data: `${text}\r` });
      setDraft('');
    } catch (e) { setError(t('session.send_failed', { error: e instanceof Error ? e.message : String(e) })); }
  };
  const interrupt = () => { void client?.request('session.interrupt', { id: session.id }).catch(() => {}); };

  const list = useMemo(() => (conversation ? rows(conversation).filter(row => row.content || row.toolName) : []), [conversation]);
  const busy = conversation ? isBusy(conversation) : false;
  const heading = (conversation && title(conversation)) || session.title || session.tool;

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: theme.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={12}><Text style={[styles.back, { color: theme.accent }]}>‹</Text></Pressable>
        <Text numberOfLines={1} style={[styles.heading, { color: theme.text }]}>{heading}</Text>
        {(busy || !conversation) && <Pressable accessibilityRole="button" onPress={interrupt} hitSlop={8}><Text style={[styles.stop, { color: theme.danger }]}>{t('session.stop')}</Text></Pressable>}
      </View>

      {conversation
        ? <FlatList
          data={[...list].reverse()}
          inverted
          keyExtractor={(row, index) => row.id || String(index)}
          contentContainerStyle={styles.messages}
          ListEmptyComponent={<Text style={[styles.hint, { color: theme.muted }]}>{t('session.waiting')}</Text>}
          renderItem={({ item }) => <Message row={item} theme={theme} />}
        />
        : <ScrollView style={[styles.terminal, { backgroundColor: theme.code }]} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={[styles.mono, { color: theme.text }]}>{terminal || t('session.waiting')}</Text>
        </ScrollView>}

      {!!error && <Text style={[styles.hint, { color: theme.danger, paddingHorizontal: 16 }]}>{error}</Text>}
      <View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.card }]}>
        <TextInput value={draft} onChangeText={setDraft} multiline placeholder={t('session.placeholder')} placeholderTextColor={theme.muted} style={[styles.input, { color: theme.text }]} />
        <Pressable accessibilityRole="button" disabled={!draft.trim()} onPress={() => void send()} style={[styles.send, { backgroundColor: theme.accent, opacity: draft.trim() ? 1 : 0.4 }]}>
          <Text style={{ color: theme.accentText, fontWeight: '600' }}>{t('session.send')}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const Message = memo(function Message({ row, theme }: { row: Row; theme: Theme }) {
  const [open, setOpen] = useState(false);
  if (row.role === 'user') return <View style={[styles.user, { backgroundColor: theme.user }]}><Text selectable style={[styles.text, { color: theme.text }]}>{row.content}</Text></View>;
  if (row.role === 'tool') return (
    <Pressable onPress={() => setOpen(v => !v)} style={[styles.tool, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <Text style={[styles.toolName, { color: row.toolStatus === 'failed' ? theme.danger : theme.muted }]}>{row.toolStatus === 'running' ? '◌' : row.toolStatus === 'failed' ? '✕' : '✓'}  {row.toolName ?? t('role.tool')}</Text>
      {!!row.content && <Text selectable numberOfLines={open ? undefined : 3} style={[styles.mono, { color: theme.muted }]}>{row.content}</Text>}
    </Pressable>
  );
  if (row.role === 'reasoning') return <Pressable onPress={() => setOpen(v => !v)}><Text numberOfLines={open ? undefined : 2} style={[styles.reasoning, { color: theme.muted }]}>{row.content}</Text></Pressable>;
  return <Text selectable style={[styles.text, styles.assistant, { color: row.role === 'notice' ? theme.muted : theme.text }]}>{row.content}</Text>;
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 56, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { fontSize: 32, lineHeight: 32, marginTop: -4 },
  heading: { flex: 1, fontSize: 17, fontWeight: '600' },
  stop: { fontSize: 15, fontWeight: '600' },
  messages: { padding: 16, gap: 12, maxWidth: 760, width: '100%', alignSelf: 'center' },
  hint: { fontSize: 13, textAlign: 'center', padding: 24 },
  user: { alignSelf: 'flex-end', maxWidth: '85%', borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  assistant: { paddingHorizontal: 2 },
  text: { fontSize: 16, lineHeight: 24 },
  reasoning: { fontSize: 14, lineHeight: 20, fontStyle: 'italic', paddingHorizontal: 2 },
  tool: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 6 },
  toolName: { fontSize: 13, fontWeight: '600' },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' }), fontSize: 12, lineHeight: 17 },
  terminal: { flex: 1 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 10, paddingBottom: 28, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, maxHeight: 140, fontSize: 16, paddingHorizontal: 6, paddingVertical: 8 },
  send: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
});
