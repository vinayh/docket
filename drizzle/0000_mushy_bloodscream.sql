CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_log` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `canonical_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`origin_version_id` text NOT NULL,
	`origin_user_id` text,
	`origin_user_email` text,
	`origin_user_display_name` text,
	`origin_photo_hash` text,
	`origin_timestamp` integer NOT NULL,
	`kind` text DEFAULT 'comment' NOT NULL,
	`anchor` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`parent_comment_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_comment_id`) REFERENCES `canonical_comment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `canonical_comment_project_idx` ON `canonical_comment` (`project_id`);--> statement-breakpoint
CREATE TABLE `comment_projection` (
	`canonical_comment_id` text NOT NULL,
	`version_id` text NOT NULL,
	`google_comment_id` text,
	`anchor_match_confidence` integer,
	`projection_status` text NOT NULL,
	`last_synced_at` integer NOT NULL,
	PRIMARY KEY(`canonical_comment_id`, `version_id`),
	FOREIGN KEY (`canonical_comment_id`) REFERENCES `canonical_comment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_projection_version_google_unique` ON `comment_projection` (`version_id`,`google_comment_id`);--> statement-breakpoint
CREATE TABLE `derivative` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text NOT NULL,
	`overlay_id` text NOT NULL,
	`google_doc_id` text NOT NULL,
	`audience_label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`overlay_id`) REFERENCES `overlay`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `drive_watch_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`token` text,
	`address` text NOT NULL,
	`expiration` integer,
	`created_at` integer NOT NULL,
	`last_event_at` integer,
	`last_synced_at` integer,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_watch_channel_channel_id_unique` ON `drive_watch_channel` (`channel_id`);--> statement-breakpoint
CREATE INDEX `drive_watch_version_idx` ON `drive_watch_channel` (`version_id`);--> statement-breakpoint
CREATE TABLE `overlay` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `overlay_project_idx` ON `overlay` (`project_id`);--> statement-breakpoint
CREATE TABLE `overlay_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`overlay_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`type` text NOT NULL,
	`anchor` text NOT NULL,
	`payload` text,
	`confidence_threshold` integer,
	FOREIGN KEY (`overlay_id`) REFERENCES `overlay`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `overlay_op_overlay_idx` ON `overlay_operation` (`overlay_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_doc_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_doc_owner_unique` ON `project` (`parent_doc_id`,`owner_user_id`);--> statement-breakpoint
CREATE TABLE `review_action_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`review_request_id` text NOT NULL,
	`assignee_user_id` text NOT NULL,
	`action` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_action_token_token_hash_unique` ON `review_action_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `review_action_token_assignment_idx` ON `review_action_token` (`review_request_id`,`assignee_user_id`);--> statement-breakpoint
CREATE TABLE `review_assignment` (
	`review_request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`responded_at` integer,
	PRIMARY KEY(`review_request_id`, `user_id`),
	FOREIGN KEY (`review_request_id`) REFERENCES `review_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_request` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`deadline` integer,
	`slack_thread_ref` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `version` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`google_doc_id` text NOT NULL,
	`parent_version_id` text,
	`label` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`snapshot_content_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `version_project_idx` ON `version` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `version_project_label_unique` ON `version` (`project_id`,`label`);