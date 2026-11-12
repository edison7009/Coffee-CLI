import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useConnection } from '../connection';
import { t, type Key } from '../i18n';
import { useTheme } from '../theme';

export interface SessionInfo { id: string; tool: string; kind: string | null; view: 'conversation' | 'terminal'; title: string; cwd: string; status: string | null; updatedAt: number | null }

const TOOL_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', dsh: 'DeepSeek Harness' };
const folder = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

export function SessionsScreen({ onOpen }: { onOpen(session: SessionInfo): void }) {
  const theme = useTheme();
  const { client, status, pairing, forget } = useConnection();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    try { setSessions((await client.request<{ sessions: SessionInfo[] }>('session.list')).sessions); } catch { /* shown as offline */ }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void load();
    // Status and title changes arrive as session.changed; re-read the list, coalescing bursts.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onEvent(event => { if (event.event === 'session.changed') { clearTimeout(pending); pending = setTimeout(() => void load(), 300); } });
    return () => { stop(); clearTimeout(pending); };
  }, [client, load]);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>{t('sessions.title')}</Text>
        {!!pairing?.computerName && <Text style={[styles.sub, { color: theme.muted }]}>{pairing.computerName}</Text>}
      </View>
      {status === 'revoked' && <Banner text={t('sessions.revoked')} action={t('sessions.repair')} onPress={() => void forget()} />}
      {(status === 'offline' || status === 'connecting') && sessions && <Banner text={t('sessions.offline')} />}
      <FlatList
        data={sessions ?? []}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={theme.accent} />}
        ListEmptyComponent={sessions ? <Text style={[styles.sub, { color: theme.muted, textAlign: 'center', marginTop: 48 }]}>{t('sessions.empty')}</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={({ pressed }) => [styles.card, { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.7 : 1 }]}>
            <View style={styles.cardTop}>
              <Text style={[styles.tool, { color: theme.accent }]}>{TOOL_NAMES[item.tool] ?? item.tool}</Text>
              <StatusPill status={item.status} />
            </View>
            <Text numberOfLines={2} style={[styles.cardTitle, { color: theme.text }]}>{item.title || folder(item.cwd) || item.tool}</Text>
            <Text numberOfLines={1} style={[styles.sub, { color: theme.muted }]}>{item.view === 'terminal' ? `${t('session.terminal')} · ` : ''}{folder(item.cwd)}</Text>
          </Pressable>
        )}
        ListFooterComponent={<Pressable accessibilityRole="button" onPress={() => void forget()} style={styles.forget}><Text style={[styles.sub, { color: theme.muted }]}>{t('sessions.forget')}</Text></Pressable>}
      />
    </View>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const theme = useTheme();
  if (!status || !['working', 'wait_input', 'idle'].includes(status)) return null;
  const color = status === 'working' ? theme.accent : status === 'wait_input' ? theme.danger : theme.muted;
  return <View style={styles.pill}><View style={[styles.dot, { backgroundColor: color }]} /><Text style={[styles.pillText, { color }]}>{t(`status.${status}` as Key)}</Text></View>;
}

function Banner({ text, action, onPress }: { text: string; action?: string; onPress?(): void }) {
  const theme = useTheme();
  return <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.border }]}>
    <Text style={[styles.sub, { color: theme.text, flex: 1 }]}>{text}</Text>
    {action && <Pressable accessibilityRole="button" onPress={onPress}><Text style={[styles.sub, { color: theme.accent, fontWeight: '600' }]}>{action}</Text></Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 8 },
  title: { fontSize: 30, fontWeight: '700' },
  sub: { fontSize: 13 },
  list: { padding: 16, gap: 10, maxWidth: 720, width: '100%', alignSelf: 'center' },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tool: { fontSize: 13, fontWeight: '600' },
  cardTitle: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '600' },
  banner: { marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 12 },
  forget: { alignItems: 'center', paddingVertical: 24 },
});
