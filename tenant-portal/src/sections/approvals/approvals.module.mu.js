import { ApprovalsSectionService } from "./approvals-section-service.js";
import { ApprovalsResources } from "./approvals.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ApprovalsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Approvals");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ApprovalsSectionService), (p) => new ApprovalsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Approvals");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ApprovalsIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ApprovalsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ApprovalsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
