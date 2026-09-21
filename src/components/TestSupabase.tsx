// src/components/TestSupabase.tsx
import React, { useEffect, useState } from "react";
import { supabase, rehydrateSession } from "../lib/supabase-client";

const TestSupabase: React.FC = () => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [agents, setAgents] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Attempt to rehydrate session on component mount
        rehydrateSession();
    }, []);

    const handleSignIn = async () => {
        setLoading(true);
        setError(null);
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });
        if (error) {
            setError(error.message);
        } else {
            fetchAgents();
        }
        setLoading(false);
    };

    const fetchAgents = async () => {
        const { data, error } = await supabase.from("agents").select("id, name, status");
        if (error) {
            setError(error.message);
        } else {
            setAgents(data ?? []);
        }
    };

    return (
        <div className="p-4 border rounded-lg max-w-md mx-auto">
            <h2 className="text-xl font-bold mb-4">Supabase Test</h2>
            <div className="flex flex-col gap-2 mb-4">
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="border px-2 py-1 rounded"
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="border px-2 py-1 rounded"
                />
                <button
                    onClick={handleSignIn}
                    disabled={loading}
                    className="bg-orange-600 text-white px-4 py-2 rounded hover:bg-orange-700"
                >
                    {loading ? "Signing in..." : "Sign In"}
                </button>
            </div>
            {error && <p className="text-red-500 mb-2">Error: {error}</p>}
            <button
                onClick={fetchAgents}
                className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700"
            >
                Load Agents
            </button>
            <ul className="mt-4">
                {agents.map((agent) => (
                    <li key={agent.id} className="border-b py-1">
                        {agent.name} – {agent.status}
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default TestSupabase;
