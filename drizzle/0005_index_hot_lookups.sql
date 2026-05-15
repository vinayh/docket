CREATE INDEX `project_parent_doc_idx` ON `project` (`parent_doc_id`);--> statement-breakpoint
CREATE INDEX `project_owner_idx` ON `project` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `review_assignment_user_idx` ON `review_assignment` (`user_id`);--> statement-breakpoint
CREATE INDEX `version_google_doc_idx` ON `version` (`google_doc_id`);