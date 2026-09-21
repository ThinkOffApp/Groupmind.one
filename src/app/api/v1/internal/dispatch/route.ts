// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, after } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { sendRoomWebhook, sendDMWebhook, extractMentions, type RoomMessageWebhookPayload, type DMMessageWebhookPayload } from '@/lib/webhook';
import { dispatchUrgentWatchAlerts } from '@/lib/watch-alerts';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

export const runtime = 'edge';

const supabase = getServiceSupabase();

export async function POST(request: Request) {
    try {
        const authHeader = request.headers.get('Authorization');
        const isHeaderValid = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()}`;

        if (!isHeaderValid) {
            return NextResponse.json({ error: 'Unauthorized internal call' }, { status: 401 });
        }

        const payload = await request.json();

        const { type, roomId, room, toAgentId, safeBody, message, sender, originService } = payload;
        const recipientUserId = message?.metadata?.dm?.to_user_id || null;

        after(async () => {
            // Cross-service message projections
            // Create projections so messages are visible across all services
            if (message?.id && toAgentId) {
                try {
                    const services = ['antfarm', 'xfor'];
                    const origin = originService || 'antfarm';
                    const targetServices = services.filter(s => s !== origin);

                    const projections = targetServices.map(service => ({
                        canonical_message_id: message.id,
                        service,
                        recipient_id: toAgentId,
                        delivery_state: 'delivered',
                        delivered_at: new Date().toISOString(),
                    }));

                    // Also create a projection for the sender in other services
                    if (sender?.id && sender.id !== WEB_USER_AGENT_ID) {
                        targetServices.forEach(service => {
                            projections.push({
                                canonical_message_id: message.id,
                                service,
                                recipient_id: sender.id,
                                delivery_state: 'delivered',
                                delivered_at: new Date().toISOString(),
                            });
                        });
                    }

                    if (projections.length > 0) {
                        const { error: projError } = await supabase
                            .from('message_projections')
                            .upsert(projections, { onConflict: 'canonical_message_id,service,recipient_id' });
                        if (projError) {
                            console.error('[Projections] Failed to create:', projError);
                        } else {
                            console.log(`[Projections] Created ${projections.length} projections for message ${message.id} from ${origin}`);
                        }
                    }
                } catch (e) {
                    console.error('[Projections] Error creating projections:', e);
                }
            }

            if (type === 'room_message' && roomId && room) {
                try {
                    const mentions = extractMentions(safeBody);

                    // Urgent watch alerts (explicit URGENT tag + direct @mention gate)
                    if (mentions.length > 0) {
                        try {
                            const watchResult = await dispatchUrgentWatchAlerts({
                                supabase,
                                room,
                                message,
                                sender,
                                safeBody,
                                mentions,
                            });
                            if (watchResult.triggered) {
                                console.log(
                                    `[WatchAlerts] room=${room.slug} sent=${watchResult.sent} reason=${watchResult.reason}`
                                );
                            }
                        } catch (watchErr) {
                            console.error('[WatchAlerts] dispatch failure:', watchErr);
                        }
                    }

                    // In-app notifications for @mentioned agents
                    if (mentions.length > 0) {
                        const mentionHandles = mentions.map((m: string) => `@${m.toLowerCase()}`);
                        const { data: mentionedAgents } = await supabase
                            .from('agents')
                            .select('id, handle')
                            .in('handle', mentionHandles);

                        if (mentionedAgents && mentionedAgents.length > 0) {
                            const senderAgentId = sender.id;
                            const preview = safeBody.length > 100 ? safeBody.slice(0, 100) + '...' : safeBody;
                            const notifRows = mentionedAgents
                                .filter(a => a.id !== senderAgentId)
                                .map(a => ({
                                    user_id: a.id,
                                    actor_id: senderAgentId,
                                    type: 'room_mention',
                                    content: `mentioned you in #${room.slug}: ${preview}`,
                                    reference_id: message.id,
                                    source_platform: 'antfarm',
                                }));
                            if (notifRows.length > 0) {
                                await supabase.from('xfb_notifications').insert(notifRows);
                            }
                        }
                    }

                    let membersQuery = supabase
                        .from('room_members')
                        .select(`
                            agent_id,
                            agents!inner(id, handle, webhook_url)
                        `)
                        .eq('room_id', roomId)
                        .not('agents.webhook_url', 'is', null);

                    if (sender.id && sender.id !== WEB_USER_AGENT_ID) {
                        membersQuery = membersQuery.neq('agent_id', sender.id);
                    }

                    const { data: members, error: membersError } = await membersQuery;

                    console.log(`[Edge Room Webhook] Room ${room.slug}: Found ${members?.length || 0} members with webhook URLs`);

                    if (members && members.length > 0) {
                        const results = await Promise.allSettled(members.map(member => {
                            const memberAgent = member.agents as unknown as {
                                id: string;
                                handle: string;
                                webhook_url: string
                            };

                            if (!memberAgent?.webhook_url) return Promise.resolve();

                            const webhookPayload: RoomMessageWebhookPayload = {
                                type: 'room_message',
                                room: {
                                    id: room.id,
                                    slug: room.slug,
                                    name: room.name,
                                },
                                message: {
                                    id: message.id,
                                    body: safeBody,
                                    created_at: message.created_at,
                                    reply_to: message.reply_to || null,
                                },
                                from: {
                                    handle: sender.handle,
                                    name: sender.name,
                                    is_human: sender.isHuman,
                                },
                                mentioned: mentions.includes(memberAgent.handle.replace('@', '').toLowerCase()),
                            };

                            console.log(`[Edge Room Webhook] Sending to ${memberAgent.handle} at ${memberAgent.webhook_url}`);

                            return sendRoomWebhook(memberAgent.webhook_url, webhookPayload).catch(async (err) => {
                                console.warn(`[Edge Webhook Fail] Queuing retry for ${memberAgent.handle}:`, err);
                                try {
                                    await supabase.from('webhook_queue').insert({
                                        url: memberAgent.webhook_url,
                                        payload: webhookPayload,
                                        attempts: 1,
                                        status: 'pending',
                                        last_attempt_at: new Date().toISOString()
                                    });
                                } catch (qErr) {
                                    console.error('[Edge Webhook Queue] Failed to enqueue:', qErr);
                                }
                            });
                        }));

                        console.log(`[Edge Room Webhook] All webhooks settled.`);
                    }
                } catch (e) {
                    console.error('Error sending room webhooks from Edge:', e);
                }
            }

            if (type === 'dm_message' && (toAgentId || recipientUserId)) {
                try {
                    const bodyPreview = safeBody.length > 100 ? safeBody.slice(0, 100) + '...' : safeBody;

                    if (toAgentId) {
                        const { data: recipientAgent } = await supabase
                            .from('agents')
                            .select('id, handle, webhook_url')
                            .eq('id', toAgentId)
                            .single();

                        if (recipientAgent) {
                            if (recipientAgent.webhook_url) {
                                const dmPayload: DMMessageWebhookPayload = {
                                    type: 'dm_message',
                                    message: {
                                        id: message.id,
                                        body: safeBody,
                                        created_at: message.created_at,
                                    },
                                    from: {
                                        handle: sender.handle,
                                        name: sender.name,
                                        is_human: sender.isHuman,
                                    },
                                };

                                console.log(`[Edge DM Webhook] Sending to ${recipientAgent.handle} at ${recipientAgent.webhook_url}`);
                                await sendDMWebhook(recipientAgent.webhook_url, dmPayload).catch(err => {
                                    console.warn(`[Edge DM Webhook Fail] ${recipientAgent.handle}:`, err);
                                });
                            }

                            await supabase.from('xfb_notifications').insert({
                                user_id: toAgentId,
                                actor_id: sender.id,
                                type: 'mention',
                                content: `DM from ${sender.handle}: ${bodyPreview}`,
                                reference_id: message.id,
                            });
                        }
                    }

                    if (recipientUserId) {
                        await supabase.from('xfb_notifications').insert({
                            user_id: recipientUserId,
                            actor_id: sender.id,
                            type: 'mention',
                            content: `DM from ${sender.handle}: ${bodyPreview}`,
                            reference_id: message.id,
                        });
                    }
                } catch (e) {
                    console.error('Error sending DM webhook/notification from Edge:', e);
                }
            }
        });

        return NextResponse.json({ success: true, decoupled: true }, { status: 202 });

    } catch (e) {
        console.error('Error parsing dispatch payload:', e);
        return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }
}
