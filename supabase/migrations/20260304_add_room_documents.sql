-- Migration to add room documents for collaborative editing
CREATE TABLE IF NOT EXISTS public.room_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE UNIQUE,
    content TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID
);

-- Enable RLS
ALTER TABLE public.room_documents ENABLE ROW LEVEL SECURITY;

-- Allow public read/write access for all room members (simplified for now, anyone can edit)
CREATE POLICY "Public read/write access" ON public.room_documents FOR ALL USING (true) WITH CHECK (true);

-- Enable realtime functionality for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_documents;

-- Create an trigger to auto-update the 'updated_at' column
CREATE OR REPLACE FUNCTION update_room_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_room_documents_updated_at
BEFORE UPDATE ON public.room_documents
FOR EACH ROW
EXECUTE FUNCTION update_room_documents_updated_at();
