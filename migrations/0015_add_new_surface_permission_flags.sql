-- Two flags for surfaces that do not exist yet: resident-tier walkthrough
-- completion (household leader and steward) and the per-property setup
-- checklist. Both land ahead of their features on purpose, so the features
-- arrive gated rather than open.
--
-- No backfill. Unlike 0014, which had to preserve access staff already had,
-- nothing here grants access anyone holds today -- false for everybody is
-- the correct starting state, and a grant is a later data change.
ALTER TABLE "user_permissions" ADD COLUMN "can_complete_walkthroughs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "can_manage_property_setup" boolean DEFAULT false NOT NULL;
