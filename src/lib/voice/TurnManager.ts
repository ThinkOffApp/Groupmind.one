// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TurnManager - Centralized turn controller for multi-AI voice chat
 * 
 * Gates audio output so only one AI speaks at a time.
 * Supports round-robin, free-for-all, and moderator modes.
 * Human voice always has barge-in priority.
 */

export type TurnMode = 'round-robin' | 'free-for-all' | 'moderator';

export interface TurnManagerConfig {
    mode: TurnMode;
    turnTimeoutMs: number;        // Max time per turn (auto-release)
    silenceReleaseMs: number;     // Silence before releasing floor
    humanPriority: boolean;       // Human always interrupts
}

export type TurnEventType = 'turn-granted' | 'turn-queued' | 'turn-released' | 'turn-timeout';

export interface TurnEvent {
    type: TurnEventType;
    participantId: string;
    queuePosition?: number;       // For turn-queued events
}

export type TurnEventHandler = (event: TurnEvent) => void;

const DEFAULT_CONFIG: TurnManagerConfig = {
    mode: 'round-robin',
    turnTimeoutMs: 15000,
    silenceReleaseMs: 1500,
    humanPriority: true,
};

export class TurnManager {
    private config: TurnManagerConfig;
    private currentSpeaker: string | null = null;
    private turnQueue: string[] = [];
    private turnOrder: string[] = [];            // Round-robin order
    private lastSpeakerIndex = -1;               // For round-robin rotation
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    private turnTimer: ReturnType<typeof setTimeout> | null = null;
    private eventHandlers = new Set<TurnEventHandler>();

    // Callbacks set by MultiAIVoiceChatExtended
    onInterrupt: ((participantId: string) => void) | null = null;

    constructor(config: Partial<TurnManagerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // --- Event system ---

    addEventListener(handler: TurnEventHandler) {
        this.eventHandlers.add(handler);
    }

    removeEventListener(handler: TurnEventHandler) {
        this.eventHandlers.delete(handler);
    }

    private emit(event: TurnEvent) {
        this.eventHandlers.forEach(h => h(event));
    }

    // --- Participant registration ---

    addParticipant(participantId: string) {
        if (!this.turnOrder.includes(participantId) && participantId !== 'user') {
            this.turnOrder.push(participantId);
        }
    }

    removeParticipant(participantId: string) {
        this.turnOrder = this.turnOrder.filter(id => id !== participantId);
        this.turnQueue = this.turnQueue.filter(id => id !== participantId);
        if (this.currentSpeaker === participantId) {
            this.releaseTurn(participantId);
        }
    }

    // --- Core turn logic ---

    /**
     * Request the floor. Returns true if granted immediately, false if queued.
     */
    requestTurn(participantId: string): boolean {
        // User always gets the floor
        if (participantId === 'user') {
            this.grantUserFloor();
            return true;
        }

        // Nobody speaking — grant immediately
        if (!this.currentSpeaker) {
            if (this.config.mode === 'round-robin') {
                // In round-robin, only grant if it's this participant's turn
                const nextId = this.getNextInRotation();
                if (nextId === participantId || !this.turnQueue.some(id => id !== participantId)) {
                    this.grantTurn(participantId);
                    return true;
                } else {
                    // Not their turn, but no one else is speaking — grant anyway if queue empty
                    if (this.turnQueue.length === 0) {
                        this.grantTurn(participantId);
                        return true;
                    }
                }
            } else {
                // free-for-all or moderator: first come first served
                this.grantTurn(participantId);
                return true;
            }
        }

        // Someone else is speaking — queue this participant
        if (this.currentSpeaker !== participantId && !this.turnQueue.includes(participantId)) {
            this.turnQueue.push(participantId);
            this.emit({
                type: 'turn-queued',
                participantId,
                queuePosition: this.turnQueue.length,
            });
        }

        return this.currentSpeaker === participantId;
    }

    /**
     * Gate function: should this participant's audio be played?
     * Call this on every audio chunk from a realtime model.
     */
    shouldPlayAudio(participantId: string): boolean {
        // User audio always plays
        if (participantId === 'user') return true;

        // If this participant holds the floor, play
        if (this.currentSpeaker === participantId) {
            this.resetSilenceTimer(participantId);
            return true;
        }

        // Nobody is speaking — try to claim the floor
        if (!this.currentSpeaker) {
            const granted = this.requestTurn(participantId);
            return granted;
        }

        // Someone else is speaking — do NOT play, queue instead
        if (!this.turnQueue.includes(participantId)) {
            this.turnQueue.push(participantId);
            this.emit({
                type: 'turn-queued',
                participantId,
                queuePosition: this.turnQueue.length,
            });
        }
        return false;
    }

    /**
     * Release the floor and advance to next speaker.
     */
    releaseTurn(participantId: string) {
        if (this.currentSpeaker !== participantId) return;

        this.clearTimers();
        this.currentSpeaker = null;

        // Update round-robin index
        const idx = this.turnOrder.indexOf(participantId);
        if (idx !== -1) {
            this.lastSpeakerIndex = idx;
        }

        this.emit({ type: 'turn-released', participantId });

        // Advance to next queued speaker
        this.advanceQueue();
    }

    /**
     * Human barge-in — immediately interrupts current speaker.
     */
    forceInterrupt(userId: string = 'user') {
        if (!this.config.humanPriority && userId === 'user') return;

        if (this.currentSpeaker && this.currentSpeaker !== userId) {
            const interrupted = this.currentSpeaker;

            // Interrupt the current speaker via callback
            if (this.onInterrupt) {
                this.onInterrupt(interrupted);
            }

            this.clearTimers();
            this.currentSpeaker = null;
            this.emit({ type: 'turn-released', participantId: interrupted });
        }

        // Grant floor to user
        if (userId === 'user') {
            this.grantTurn('user');
        }
    }

    // --- Mode management ---

    setMode(mode: TurnMode) {
        this.config.mode = mode;
        console.log(`[TurnManager] Mode changed to: ${mode}`);
    }

    getMode(): TurnMode {
        return this.config.mode;
    }

    getCurrentSpeaker(): string | null {
        return this.currentSpeaker;
    }

    getQueue(): string[] {
        return [...this.turnQueue];
    }

    // --- Internal helpers ---

    private grantUserFloor() {
        if (this.currentSpeaker && this.currentSpeaker !== 'user') {
            this.forceInterrupt('user');
        } else {
            this.grantTurn('user');
        }
    }

    private grantTurn(participantId: string) {
        this.currentSpeaker = participantId;

        // Remove from queue if present
        this.turnQueue = this.turnQueue.filter(id => id !== participantId);

        // Start turn timeout (max speaking time)
        if (participantId !== 'user') {
            this.startTurnTimeout(participantId);
        }

        // Start silence timer
        this.resetSilenceTimer(participantId);

        this.emit({ type: 'turn-granted', participantId });
        console.log(`[TurnManager] Floor granted to: ${participantId}`);
    }

    private advanceQueue() {
        if (this.turnQueue.length > 0) {
            let nextId: string;

            if (this.config.mode === 'round-robin') {
                // Pick the next participant in rotation order from the queue
                nextId = this.pickFromQueueByRotation();
            } else {
                // FIFO for free-for-all
                nextId = this.turnQueue[0];
            }

            this.turnQueue = this.turnQueue.filter(id => id !== nextId);
            this.grantTurn(nextId);
        }
    }

    private getNextInRotation(): string | null {
        if (this.turnOrder.length === 0) return null;
        const nextIdx = (this.lastSpeakerIndex + 1) % this.turnOrder.length;
        return this.turnOrder[nextIdx];
    }

    private pickFromQueueByRotation(): string {
        // Find the queued participant closest to next in rotation
        const nextInOrder = this.getNextInRotation();
        if (nextInOrder && this.turnQueue.includes(nextInOrder)) {
            return nextInOrder;
        }
        // Fallback: walk rotation order and pick first queued
        for (let i = 0; i < this.turnOrder.length; i++) {
            const idx = (this.lastSpeakerIndex + 1 + i) % this.turnOrder.length;
            const candidate = this.turnOrder[idx];
            if (this.turnQueue.includes(candidate)) {
                return candidate;
            }
        }
        // Absolute fallback: first in queue
        return this.turnQueue[0];
    }

    private resetSilenceTimer(participantId: string) {
        if (this.silenceTimer) clearTimeout(this.silenceTimer);

        // Don't auto-release user's floor via silence timer
        if (participantId === 'user') return;

        this.silenceTimer = setTimeout(() => {
            if (this.currentSpeaker === participantId) {
                console.log(`[TurnManager] Silence timeout — releasing ${participantId}`);
                this.releaseTurn(participantId);
            }
        }, this.config.silenceReleaseMs);
    }

    private startTurnTimeout(participantId: string) {
        if (this.turnTimer) clearTimeout(this.turnTimer);

        this.turnTimer = setTimeout(() => {
            if (this.currentSpeaker === participantId) {
                console.log(`[TurnManager] Turn timeout — releasing ${participantId}`);
                this.emit({ type: 'turn-timeout', participantId });

                // Interrupt via callback
                if (this.onInterrupt) {
                    this.onInterrupt(participantId);
                }

                this.releaseTurn(participantId);
            }
        }, this.config.turnTimeoutMs);
    }

    private clearTimers() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    /**
     * Enqueue all AI participants for a round of responses.
     * Call this after user finishes speaking to set up the response round.
     */
    enqueueResponseRound() {
        if (this.config.mode !== 'round-robin') return;

        // Build the queue in rotation order starting after last speaker
        const queue: string[] = [];
        for (let i = 0; i < this.turnOrder.length; i++) {
            const idx = (this.lastSpeakerIndex + 1 + i) % this.turnOrder.length;
            const id = this.turnOrder[idx];
            if (!queue.includes(id) && id !== this.currentSpeaker) {
                queue.push(id);
            }
        }
        this.turnQueue = queue;
        console.log(`[TurnManager] Response round queued:`, queue);
    }

    dispose() {
        this.clearTimers();
        this.eventHandlers.clear();
        this.turnQueue = [];
        this.turnOrder = [];
        this.currentSpeaker = null;
        this.onInterrupt = null;
    }
}
