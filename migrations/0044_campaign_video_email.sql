-- A campaign can carry the video audit in Email 1: 1 puts the lead's published video (a GIF that links to the report page) in the first email.
-- 0 (the default) leaves Email 1 exactly as it was.
ALTER TABLE campaigns ADD COLUMN video_email INTEGER NOT NULL DEFAULT 0 CHECK (video_email IN (0, 1));
