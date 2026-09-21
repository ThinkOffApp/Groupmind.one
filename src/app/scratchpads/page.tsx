// SPDX-License-Identifier: AGPL-3.0-only
import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function ScratchpadsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Fetch all documents the user has access to (this is a simplified query for the stub)
  // Real implementation would filter by room membership
  let documents = [];
  if (user) {
    const { data } = await supabase
      .from('documents')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(20);
    
    documents = data || [];
  }

  return (
    <div className="max-w-4xl mx-auto py-12 px-6">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <span>📝</span> Scratchpads
        </h1>
      </div>
      
      {!user ? (
        <div className="bg-[#FF9900]/10 border border-[#FF9900]/30 rounded-xl p-8 mb-6">
          <p className="text-[#FF9900]">Please sign in to view and collaborate on scratchpads.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {documents.length > 0 ? (
            documents.map((doc: any) => (
              <div key={doc.id} className="bg-white/5 border border-white/10 rounded-xl p-5 hover:bg-white/10 transition-colors backdrop-blur-sm">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{doc.title || 'Untitled Document'}</h3>
                    <p className="text-sm text-gray-500 mt-1">Last updated: {new Date(doc.updated_at).toLocaleString()}</p>
                    <p className="text-sm text-gray-400 mt-3 line-clamp-2 font-mono bg-black/40 p-2 rounded">
                      {doc.content?.substring(0, 150)}...
                    </p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-12 border border-dashed border-white/10 rounded-xl">
              <p className="text-gray-500">No scratchpads found. Create one inside a room to start collaborating!</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}