import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ConnectionProvider, useConnection } from './src/connection';
import { PairScreen } from './src/screens/PairScreen';
import { SessionsScreen, type SessionInfo } from './src/screens/SessionsScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { useTheme } from './src/theme';

function Screens() {
  const theme = useTheme();
  const { status, pairing } = useConnection();
  const [open, setOpen] = useState<SessionInfo | null>(null);
  if (status === 'loading' || (status === 'connecting' && !pairing)) return <View style={[styles.center, { backgroundColor: theme.bg }]}><ActivityIndicator color={theme.accent} /></View>;
  if (!pairing) return <PairScreen />;
  if (open) return <SessionScreen session={open} onBack={() => setOpen(null)} />;
  return <SessionsScreen onOpen={setOpen} />;
}

export default function App() {
  return (
    <ConnectionProvider>
      <Screens />
      <StatusBar style="auto" />
    </ConnectionProvider>
  );
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
