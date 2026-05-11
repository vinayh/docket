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
CREATE INDEX `review_action_token_assignment_idx` ON `review_action_token` (`review_request_id`,`assignee_user_id`);