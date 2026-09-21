import type { Metadata } from 'next';

// Without this the tab, and every shared link, said "GroupMind | The Real-time
// AgentOS Communications Hub" - the third place CodeWatch users were shown the
// wrong product's name after the nav bar and the footer. Wording matches the
// codewatch.app landing page so the two halves of the site agree.
export const metadata: Metadata = {
    title: 'CodeWatch — watch your agents from your phone',
    description:
        'Your whole agent operation as a live kanban: PRs, agent work, and releases. ' +
        'Approve prompts, merge from your phone, and chat back from anywhere.',
};

export default function CodeWatchLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
