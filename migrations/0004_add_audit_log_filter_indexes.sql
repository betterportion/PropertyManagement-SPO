CREATE INDEX "IDX_audit_log_action" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "IDX_audit_log_actor_email" ON "audit_log" USING btree ("actor_email");