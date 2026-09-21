import { redirect } from 'next/navigation';
import { getServiceSupabase } from '@/lib/supabase-service';

type Props = { params: Promise<{ code: string }> };

export default async function JoinPage({ params }: Props) {
  const { code } = await params;

  const supabase = getServiceSupabase();
  const { data: room } = await supabase
    .from('rooms')
    .select('slug')
    .eq('invite_code', code)
    .single();

  if (room?.slug) {
    redirect(`/leaf/${code}`);
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, sans-serif',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1>Invalid Invite Code</h1>
        <p>This invite link is not valid or has expired.</p>
        <a href="/" style={{ color: '#4ade80' }}>Go to GroupMind</a>
      </div>
    </div>
  );
}
