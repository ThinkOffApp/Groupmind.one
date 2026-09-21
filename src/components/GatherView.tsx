// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import MarkdownMessage from '@/components/MarkdownMessage';

type Message = {
    id: string;
    from: string;
    from_name: string;
    body: string;
    created_at: string;
    isHuman?: boolean;
};

type Member = {
    handle: string;
    name: string;
    isHuman?: boolean;
    avatar_url?: string | null;
};

type AgentState = {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    handle: string;
    name: string;
    isHuman: boolean;
    color: string;
    emoji: string;
    bubbleText: string | null;
    bubbleOpacity: number;
    bubbleTimer: number;
    idlePhase: number;
    scale: number;
    avatarImg: HTMLImageElement | null;
};

const AGENT_COLORS = [
    '#10b981', '#3b82f6', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
    '#06b6d4', '#84cc16', '#a855f7', '#fb923c',
];

const AGENT_EMOJIS = ['🐜', '🐛', '🐝', '🪲', '🐞', '🦗', '🦟', '🪳', '🦂', '🕷️', '🐌', '🦋'];
const HUMAN_EMOJIS = ['👤', '👨‍💻', '👩‍💻', '🧑‍💻'];

function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

function getAgentColor(handle: string): string {
    return AGENT_COLORS[hashCode(handle) % AGENT_COLORS.length];
}

interface GatherViewProps {
    messages: Message[];
    members: Member[];
    roomName: string;
    onSendMessage?: (body: string) => Promise<void>;
}

export default function GatherView({ messages, members, roomName, onSendMessage }: GatherViewProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const agentsRef = useRef<Map<string, AgentState>>(new Map());
    const animFrameRef = useRef<number>(0);
    const lastMessageCountRef = useRef(0);
    const initializedRef = useRef(false);
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
    const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
    const timeRef = useRef(0);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [inputText, setInputText] = useState('');
    const [sendingMsg, setSendingMsg] = useState(false);
    const canvasSizeRef = useRef({ w: 800, h: 800 });

    // Resize canvas to match container and reposition agents
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                const dpr = window.devicePixelRatio || 1;

                // Set canvas backing store size
                canvas.width = width * dpr;
                canvas.height = height * dpr;

                // Set CSS display size to match container exactly
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;

                // Use CSS pixel dimensions for all drawing (not backing store)
                canvasSizeRef.current = { w: width, h: height };

                // Reposition existing agents in a circle at the new size
                const agents = agentsRef.current;
                if (agents.size > 0) {
                    const centerX = width / 2;
                    const centerY = height / 2;
                    const radius = Math.min(width, height) * 0.3;
                    let i = 0;
                    for (const agent of agents.values()) {
                        const angle = (i / agents.size) * Math.PI * 2 - Math.PI / 2;
                        agent.targetX = centerX + Math.cos(angle) * radius;
                        agent.targetY = centerY + Math.sin(angle) * radius;
                        i++;
                    }
                }
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    // Initialize agent positions in a circle layout
    const initAgents = useCallback(() => {
        const existing = agentsRef.current;
        const { w, h } = canvasSizeRef.current;
        const centerX = w / 2;
        const centerY = h / 2;
        const radius = Math.min(w, h) * 0.3;

        members.forEach((member, i) => {
            if (existing.has(member.handle)) return;

            const angle = (i / Math.max(members.length, 1)) * Math.PI * 2 - Math.PI / 2;
            const x = centerX + Math.cos(angle) * radius;
            const y = centerY + Math.sin(angle) * radius;
            const hash = hashCode(member.handle);

            existing.set(member.handle, {
                x,
                y,
                targetX: x,
                targetY: y,
                handle: member.handle,
                name: member.name,
                isHuman: member.isHuman || false,
                color: AGENT_COLORS[hash % AGENT_COLORS.length],
                emoji: member.isHuman
                    ? HUMAN_EMOJIS[hash % HUMAN_EMOJIS.length]
                    : AGENT_EMOJIS[hash % AGENT_EMOJIS.length],
                bubbleText: null,
                bubbleOpacity: 0,
                bubbleTimer: 0,
                idlePhase: Math.random() * Math.PI * 2,
                scale: 1,
                avatarImg: null,
            });

            // Load avatar image if available
            if (member.avatar_url) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const agent = existing.get(member.handle);
                    if (agent) agent.avatarImg = img;
                };
                img.src = member.avatar_url;
            }
        });
    }, [members]);

    // Initialize bubbles for last few messages on first load
    useEffect(() => {
        if (initializedRef.current) return;
        if (messages.length === 0 || agentsRef.current.size === 0) return;

        initializedRef.current = true;
        lastMessageCountRef.current = messages.length;

        // Show bubbles for last 3 messages with staggered fade
        const recent = messages.slice(-3);
        recent.forEach((msg, i) => {
            const agent = agentsRef.current.get(msg.from);
            if (agent) {
                agent.bubbleText = msg.body.length > 80
                    ? msg.body.substring(0, 77) + '...'
                    : msg.body;
                agent.bubbleOpacity = 1;
                agent.bubbleTimer = 8 + (2 - i) * 2; // stagger: 12s, 10s, 8s
                agent.scale = 1.05;
            }
        });
    }, [messages, agentsRef.current.size]);

    // Show chat bubble when new message arrives
    useEffect(() => {
        if (!initializedRef.current) return;
        if (messages.length > lastMessageCountRef.current) {
            const newMessages = messages.slice(lastMessageCountRef.current);
            newMessages.forEach(msg => {
                const agent = agentsRef.current.get(msg.from);
                if (agent) {
                    agent.bubbleText = msg.body.length > 80
                        ? msg.body.substring(0, 77) + '...'
                        : msg.body;
                    agent.bubbleOpacity = 1;
                    agent.bubbleTimer = 10; // longer display time
                    agent.scale = 1.15;
                }
            });
        }
        lastMessageCountRef.current = messages.length;
    }, [messages]);

    useEffect(() => {
        initAgents();
    }, [initAgents]);

    // Auto-scroll chat feed
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Canvas click handler
    const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const sizeScale = Math.min(canvasSizeRef.current.w, canvasSizeRef.current.h) / 800;
        const hitRadius = 30 * sizeScale;

        for (const [handle, agent] of agentsRef.current) {
            const dx = x - agent.x;
            const dy = y - agent.y;
            if (dx * dx + dy * dy < hitRadius * hitRadius) {
                setSelectedAgent(prev => prev === handle ? null : handle);
                return;
            }
        }
        setSelectedAgent(null);
    }, []);

    // Canvas hover handler
    const handleCanvasMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const sizeScale = Math.min(canvasSizeRef.current.w, canvasSizeRef.current.h) / 800;
        const hitRadius = 30 * sizeScale;

        let found: string | null = null;
        for (const [handle, agent] of agentsRef.current) {
            const dx = x - agent.x;
            const dy = y - agent.y;
            if (dx * dx + dy * dy < hitRadius * hitRadius) {
                found = handle;
                break;
            }
        }
        setHoveredAgent(found);
    }, []);

    // Animation loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let lastTime = performance.now();

        const draw = (now: number) => {
            const dt = Math.min((now - lastTime) / 1000, 0.1);
            lastTime = now;
            timeRef.current += dt;

            const dpr = window.devicePixelRatio || 1;
            const { w: W, h: H } = canvasSizeRef.current;

            // Reset transform and scale for DPR
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            drawGround(ctx, W, H, timeRef.current);

            // Scale factor relative to 800px reference
            const sizeScale = Math.min(W, H) / 800;

            // Room name
            ctx.save();
            ctx.font = `bold ${Math.round(18 * sizeScale)}px Inter, sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.textAlign = 'center';
            ctx.fillText(`🏠 ${roomName}`, W / 2, 30 * sizeScale);
            ctx.restore();

            // Draw connections first (behind agents)
            drawConnections(ctx, agentsRef.current);

            // Update & draw agents
            for (const agent of agentsRef.current.values()) {
                updateAgent(agent, dt, timeRef.current);
                drawAgent(ctx, agent, timeRef.current, selectedAgent, hoveredAgent, sizeScale);
            }

            animFrameRef.current = requestAnimationFrame(draw);
        };

        animFrameRef.current = requestAnimationFrame(draw);

        return () => {
            cancelAnimationFrame(animFrameRef.current);
        };
    }, [roomName, selectedAgent, hoveredAgent]);

    // Get messages for selected agent filter
    const displayMessages = selectedAgent
        ? messages.filter(m => m.from === selectedAgent).slice(-20)
        : messages.slice(-30);

    return (
        <div className="flex gap-4" style={{ height: 'calc(100vh - 10rem)' }}>
            {/* Canvas */}
            <div ref={containerRef} className="flex-1 min-w-0 relative bg-gray-950/80 border border-white/10 rounded-xl overflow-hidden">
                <canvas
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    onMouseMove={handleCanvasMove}
                    className="w-full h-full cursor-pointer"
                    style={{ imageRendering: 'auto' }}
                />

                {/* Legend */}
                <div className="absolute bottom-3 left-3 flex gap-3 text-xs text-gray-500">
                    <span>🤖 Agent</span>
                    <span>👤 Human</span>
                    <span className="text-gray-600">Click agent to filter chat</span>
                </div>
            </div>

            {/* Chat Feed — always visible */}
            <div className="bg-gray-900/50 border border-white/10 rounded-xl flex flex-col overflow-hidden" style={{ flex: '1 1 320px', maxWidth: '40%' }}>
                {/* Header */}
                <div className="p-3 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">
                            {selectedAgent ? '🔍 ' : '💬 '}
                            {selectedAgent
                                ? agentsRef.current.get(selectedAgent)?.name || selectedAgent
                                : 'Room Chat'
                            }
                        </span>
                    </div>
                    {selectedAgent && (
                        <button
                            onClick={() => setSelectedAgent(null)}
                            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded
                                       hover:bg-white/10 transition-colors"
                        >
                            Show all
                        </button>
                    )}
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    {displayMessages.length === 0 ? (
                        <p className="text-gray-500 text-sm text-center py-4">
                            No messages yet. Start chatting!
                        </p>
                    ) : (
                        displayMessages.map(msg => (
                            <div
                                key={msg.id}
                                className="bg-gray-800/50 rounded-lg p-2.5 text-sm hover:bg-gray-800/70 transition-colors cursor-pointer"
                                onClick={() => setSelectedAgent(
                                    selectedAgent === msg.from ? null : msg.from
                                )}
                            >
                                <div className="flex items-center gap-1.5 mb-1">
                                    <span
                                        className="w-2 h-2 rounded-full shrink-0"
                                        style={{ backgroundColor: getAgentColor(msg.from) }}
                                    />
                                    <span className="font-medium text-xs" style={{ color: getAgentColor(msg.from) }}>
                                        {msg.from_name}
                                    </span>
                                    <span className="text-xs text-gray-600 ml-auto">
                                        {new Date(msg.created_at).toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                </div>
                                <MarkdownMessage body={msg.body} />
                            </div>
                        ))
                    )}
                    <div ref={chatEndRef} />
                </div>

                {/* Message Input */}
                {onSendMessage && (
                    <form
                        onSubmit={async (e) => {
                            e.preventDefault();
                            if (!inputText.trim() || sendingMsg) return;
                            setSendingMsg(true);
                            try {
                                await onSendMessage(inputText.trim());
                                setInputText('');
                            } finally {
                                setSendingMsg(false);
                            }
                        }}
                        className="p-3 border-t border-white/10 flex gap-2"
                    >
                        <input
                            type="text"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            placeholder="Type a message..."
                            className="flex-1 bg-gray-800/70 border border-white/10 rounded-lg px-3 py-2
                                       text-sm text-white placeholder-gray-500
                                       focus:outline-none focus:border-[#55AA00]/50"
                        />
                        <button
                            type="submit"
                            disabled={sendingMsg || !inputText.trim()}
                            className="px-3 py-2 bg-[#55AA00] hover:bg-[#99DD00] disabled:bg-gray-700
                                       disabled:text-gray-500 text-white rounded-lg text-sm font-medium
                                       transition-colors"
                        >
                            {sendingMsg ? '...' : 'Send'}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

// ─── Drawing Helpers ───────────────────────────────────────────────

function drawGround(ctx: CanvasRenderingContext2D, W: number, H: number, time: number) {
    const grad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, W * 0.7);
    grad.addColorStop(0, '#1a1f16');
    grad.addColorStop(0.5, '#141811');
    grad.addColorStop(1, '#0d100a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Subtle dot grid
    ctx.fillStyle = 'rgba(16, 185, 129, 0.04)';
    const spacing = 40;
    for (let x = spacing; x < W; x += spacing) {
        for (let y = spacing; y < H; y += spacing) {
            const wobble = Math.sin(time * 0.5 + x * 0.01 + y * 0.01) * 0.5;
            ctx.beginPath();
            ctx.arc(x, y, 1.5 + wobble, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Outer glow ring
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.06)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.35 + Math.sin(time * 0.3) * 10, 0, Math.PI * 2);
    ctx.stroke();
}

function updateAgent(agent: AgentState, dt: number, time: number) {
    agent.x += (agent.targetX - agent.x) * dt * 3;
    agent.y += (agent.targetY - agent.y) * dt * 3;

    // Idle bobbing
    const bob = Math.sin(time * 1.5 + agent.idlePhase) * 2;
    agent.y = agent.targetY + bob;

    // Scale spring-back
    agent.scale += (1 - agent.scale) * dt * 5;

    // Bubble timer
    if (agent.bubbleTimer > 0) {
        agent.bubbleTimer -= dt;
        if (agent.bubbleTimer <= 1) {
            agent.bubbleOpacity = Math.max(0, agent.bubbleTimer);
        }
        if (agent.bubbleTimer <= 0) {
            agent.bubbleText = null;
            agent.bubbleOpacity = 0;
        }
    }
}

function drawAgent(
    ctx: CanvasRenderingContext2D,
    agent: AgentState,
    time: number,
    selectedHandle: string | null,
    hoveredHandle: string | null,
    sizeScale: number = 1
) {
    const { x, y, color, emoji, handle, scale } = agent;
    const isSelected = handle === selectedHandle;
    const isHovered = handle === hoveredHandle;
    const radius = 24 * scale * sizeScale;

    ctx.save();

    // Glow ring for selected / hovered
    if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 8 * sizeScale, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? color : color + '66';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();
    }

    // Pulse ring on new message
    if (agent.bubbleOpacity > 0) {
        const pulseRadius = radius + 12 * sizeScale + (1 - agent.bubbleOpacity) * 20 * sizeScale;
        ctx.beginPath();
        ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
        ctx.strokeStyle = color + Math.floor(agent.bubbleOpacity * 80).toString(16).padStart(2, '0');
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Shadow
    ctx.beginPath();
    ctx.ellipse(x, y + radius + 6 * sizeScale, radius * 0.75, 4 * sizeScale, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fill();

    // Body circle
    const bodyGrad = ctx.createRadialGradient(x - 5 * sizeScale, y - 5 * sizeScale, 2, x, y, radius);
    bodyGrad.addColorStop(0, color + 'cc');
    bodyGrad.addColorStop(1, color + '66');
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Emoji face or avatar image
    if (agent.avatarImg) {
        // Clip to circle and draw avatar
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, radius - 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(agent.avatarImg, x - radius + 2, y - radius + 2, (radius - 2) * 2, (radius - 2) * 2);
        ctx.restore();
    } else {
        ctx.font = `${Math.round(18 * scale * sizeScale)}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, x, y);
    }

    // Handle label below
    ctx.font = `${Math.round(11 * sizeScale)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(handle, x, y + radius + 12 * sizeScale);

    ctx.restore();

    // Chat bubble
    if (agent.bubbleText && agent.bubbleOpacity > 0) {
        drawBubble(ctx, x, y - radius - 15 * sizeScale, agent.bubbleText, agent.bubbleOpacity, color);
    }
}

function drawBubble(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    opacity: number,
    color: string
) {
    ctx.save();
    ctx.globalAlpha = opacity;

    const maxWidth = 200;
    ctx.font = '12px Inter, system-ui, sans-serif';

    // Word wrap
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    for (const word of words) {
        const test = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth - 20) {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = test;
        }
    }
    if (currentLine) lines.push(currentLine);

    const lineHeight = 17;
    const padding = 10;
    const bubbleW = Math.min(maxWidth, Math.max(...lines.map(l => ctx.measureText(l).width)) + padding * 2);
    const bubbleH = lines.length * lineHeight + padding * 2;

    const bx = x - bubbleW / 2;
    const by = y - bubbleH - 8;

    // Bubble background
    ctx.beginPath();
    roundRect(ctx, bx, by, bubbleW, bubbleH, 8);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.strokeStyle = color + '66';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Tail
    ctx.beginPath();
    ctx.moveTo(x - 6, by + bubbleH);
    ctx.lineTo(x, by + bubbleH + 8);
    ctx.lineTo(x + 6, by + bubbleH);
    ctx.fillStyle = '#1e293b';
    ctx.fill();

    // Text
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
        ctx.fillText(line, bx + padding, by + padding + i * lineHeight);
    });

    ctx.restore();
}

function drawConnections(ctx: CanvasRenderingContext2D, agents: Map<string, AgentState>) {
    const arr = [...agents.values()];
    if (arr.length < 2) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.05)';
    ctx.lineWidth = 1;

    for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i];
            const b = arr[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 300) {
                ctx.globalAlpha = Math.max(0, (300 - dist) / 300) * 0.15;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
        }
    }

    ctx.restore();
}

function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}
