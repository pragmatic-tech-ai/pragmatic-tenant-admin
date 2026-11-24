// ApprovalsModule - the platform's changes to this hive as a ShellModule (C3.4).
// One capability (rail entry) backed by ApprovalsSectionService, which
// presents the Approvals page; its view merges in from ApprovalsResources.

import ApprovalsSectionService from "./approvals-section-service.js"
import ApprovalsResources from "./approvals.resources.mu.js"

shell module ApprovalsModule [ Name = "Approvals" ] {
    .services: {
        ApprovalsSectionService
    }

    Capability [ Name = "Approvals", Icon = @ApprovalsIcon, ServiceKey = ApprovalsSectionService ]

    resources: {
        merge ApprovalsResources
    }
}
