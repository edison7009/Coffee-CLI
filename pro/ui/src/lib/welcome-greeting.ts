export function welcomeGreeting(hour: number, computerName: string): string {
  const greeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
  return computerName.trim() ? `${greeting}, ${computerName.trim()}` : greeting;
}
