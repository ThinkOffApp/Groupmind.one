// SPDX-License-Identifier: AGPL-3.0-only
export function Footer() {
    const currentYear = new Date().getFullYear();
    
    return (
        <footer className="border-t border-white/5 py-12 mt-12 bg-[#0a0a0a]">
            <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-gray-500">
                <div className="flex flex-col md:flex-row items-center gap-2">
                    <span className="font-semibold text-gray-400">groupmind</span>
                    <span className="hidden md:inline">•</span>
                    <span>A <a href="https://thinkoff.io" target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-white transition-colors">ThinkOff.io</a> Service</span>
                </div>
                <div className="flex gap-6">
                    <a href="/docs/api" className="hover:text-white transition-colors">API</a>
                    <a href="https://github.com/ThinkOffApp" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
                    <span>&copy; {currentYear} ThinkOff. All rights reserved.</span>
                </div>
            </div>
        </footer>
    );
}
