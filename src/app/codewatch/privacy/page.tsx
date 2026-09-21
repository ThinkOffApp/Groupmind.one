export const metadata = {
    title: 'CodeWatch Privacy Policy',
    description: 'Privacy policy for the CodeWatch IDE notification app',
};

export default function CodeWatchPrivacy() {
    return (
        <main style={{
            maxWidth: '720px',
            margin: '0 auto',
            padding: '40px 20px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            color: '#e0e0e0',
            backgroundColor: '#111',
            minHeight: '100vh',
            lineHeight: 1.7,
        }}>
            <h1 style={{ color: '#fff', marginBottom: '8px' }}>CodeWatch Privacy Policy</h1>
            <p style={{ color: '#888', marginBottom: '32px' }}>Last Updated: March 14, 2026</p>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Overview</h2>
                <p>
                    CodeWatch is an IDE notification relay app for phone and watch. It sends notifications
                    from your coding IDE (such as Claude Code, Cursor, VS Code, Codex, Windsurf, or Aider)
                    to your phone and watch, and lets you reply by voice or text.
                </p>
                <p>
                    CodeWatch operates in a relay model: your IDE sends events to the relay server,
                    and your phone/watch polls for or receives push notifications of those events.
                </p>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Data Collection</h2>

                <h3>What We Collect</h3>
                <ul>
                    <li><strong>Notification content:</strong> Titles, short message bodies (up to 500 characters), and source identifiers from your IDE events. These are stored temporarily and expire after 24 hours.</li>
                    <li><strong>User identity:</strong> Your Google account email and display name (via Google Sign-In), used to match notifications to your account.</li>
                    <li><strong>Device tokens:</strong> FCM (Firebase Cloud Messaging) registration tokens for push notification delivery.</li>
                    <li><strong>Reply text:</strong> When you reply to a notification from your phone or watch, the reply text is stored alongside the event and relayed back to your IDE.</li>
                </ul>

                <h3>What We Do NOT Collect</h3>
                <ul>
                    <li>Your source code or file contents</li>
                    <li>Your IDE configuration or API keys</li>
                    <li>Your location data</li>
                    <li>Your contacts or call logs</li>
                    <li>Any data from other apps on your device</li>
                </ul>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Data Flow</h2>
                <ol>
                    <li><strong>IDE to Relay:</strong> Your IDE&apos;s notification hook sends a short event (title + body snippet) to our relay server via HTTPS.</li>
                    <li><strong>Relay to Device:</strong> The relay server delivers the event to your phone/watch via FCM push notification or polling.</li>
                    <li><strong>Device to Relay:</strong> Your voice or text reply is sent back to the relay server via HTTPS.</li>
                    <li><strong>Relay to IDE:</strong> The CLI poller picks up your reply and delivers it to your IDE session.</li>
                </ol>
                <p>All communication uses HTTPS/TLS encryption. No data is sent to third parties other than Firebase Cloud Messaging for push delivery.</p>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Data Storage &amp; Retention</h2>
                <ul>
                    <li>Relay events (notifications and replies) are stored in our database and automatically expire after <strong>24 hours</strong>.</li>
                    <li>Device registration tokens are stored as long as the device is active. You can deactivate your device at any time.</li>
                    <li>Your API key is stored locally on your computer in <code>~/.codewatch/config</code> with file permissions restricted to your user account (chmod 600).</li>
                    <li>The phone/watch app stores your API key in Android EncryptedSharedPreferences.</li>
                </ul>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Third-Party Services</h2>
                <ul>
                    <li><strong>Google Sign-In:</strong> Used for authentication. Subject to <a href="https://policies.google.com/privacy" style={{ color: '#FF8C00' }}>Google&apos;s Privacy Policy</a>.</li>
                    <li><strong>Firebase Cloud Messaging:</strong> Used for push notification delivery. Subject to <a href="https://firebase.google.com/support/privacy" style={{ color: '#FF8C00' }}>Firebase Privacy Policy</a>.</li>
                    <li><strong>Supabase:</strong> Used for database storage. Subject to <a href="https://supabase.com/privacy" style={{ color: '#FF8C00' }}>Supabase Privacy Policy</a>.</li>
                </ul>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Microphone Permission</h2>
                <p>
                    CodeWatch requests microphone access on your phone and watch to enable voice replies
                    to IDE notifications. Voice audio is processed on-device by the Android Speech Recognition
                    service and converted to text. The raw audio is never transmitted to our servers.
                    Only the transcribed text is sent as a reply.
                </p>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Security</h2>
                <ul>
                    <li>All API communication uses HTTPS/TLS encryption.</li>
                    <li>API keys are transmitted via secure headers, never in URLs.</li>
                    <li>Local configuration files are protected with restrictive file permissions.</li>
                    <li>Mobile app uses Android EncryptedSharedPreferences for credential storage.</li>
                </ul>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>User Rights &amp; Data Control</h2>
                <ul>
                    <li>You can disconnect CodeWatch from your IDEs at any time by running <code>codewatch disconnect</code>.</li>
                    <li>You can delete your local configuration by removing <code>~/.codewatch/</code>.</li>
                    <li>Relay events automatically expire after 24 hours.</li>
                    <li>You can request account and data deletion by contacting us.</li>
                </ul>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Children&apos;s Privacy</h2>
                <p>CodeWatch is not designed for users under 13 years of age.</p>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Changes to This Policy</h2>
                <p>
                    We may update this privacy policy from time to time. Changes will be posted on this page
                    with an updated &quot;Last Updated&quot; date.
                </p>
            </section>

            <section>
                <h2 style={{ color: '#FF8C00', borderBottom: '1px solid #333', paddingBottom: '8px' }}>Contact</h2>
                <p>
                    Questions about this privacy policy may be directed to{' '}
                    <a href="mailto:hello@thinkoff.app" style={{ color: '#FF8C00' }}>hello@thinkoff.app</a>
                </p>
            </section>

            <footer style={{ marginTop: '48px', paddingTop: '24px', borderTop: '1px solid #333', color: '#666', fontSize: '14px' }}>
                <p>&copy; 2026 ThinkOff. All rights reserved.</p>
            </footer>
        </main>
    );
}
