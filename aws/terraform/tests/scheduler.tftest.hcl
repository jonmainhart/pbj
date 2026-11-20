mock_provider "aws" {}

run "scheduler_input" {
  command = plan

  assert {
    # Compare the rendered raw string: jsondecode would hide escaped angle brackets.
    condition     = trimspace(aws_scheduler_schedule.create_week.target[0].input) == "{\"action\":\"create_week\",\"scheduled_time\":\"<aws.scheduler.scheduled-time>\"}"
    error_message = "Scheduler input must preserve the literal scheduled-time context attribute."
  }
}
