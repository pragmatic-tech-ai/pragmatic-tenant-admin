// approvals.resources.mu - the Approvals section's view (C3.4).
//
// ApprovalsViewModel is presented full-width in the shell's content region,
// matched implicitly by type. Each intent row says what Pragmatic asks in
// plain words, when it expires and where it stands; Approve and Reject show
// only while it waits and has not expired. The rows use a keyed template set
// as the ListBox's ItemTemplate (the rows are Observables).

import ApprovalsViewModel from "./approvals-view-model.js"
import ApprovalRowViewModel from "./approvals-view-model.js"

resources ApprovalsResources {
    DataTemplate [ DataType = ApprovalsViewModel ] {
        DockPanel [ Margin = (24,20,24,20) ] {
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Margin = (0,0,0,16) ] {
                TextBlock [ Text = "Approvals", Style = @H3, Foreground = @Fg0 ]
                TextBlock [ Text = "Changes Pragmatic asked this hive to make. A hive connected as Enrolled applies each one only after a tenant admin approves it here; a Delegated hive applies them at once and lists them for the record.",
                            Style = @Body, Foreground = @Fg2, TextWrapping = Wrap, Margin = (0,4,0,0) ]
            }

            TextBlock [ DockPanel.Dock = Top, Text = "Loading the changes from your hive...", Foreground = @Fg2,
                        Visibility = $IsLoading << ToVisibility ]
            TextBlock [ DockPanel.Dock = Top, Text = "No changes from Pragmatic. They appear here once this hive is connected and Pragmatic sends one.",
                        Foreground = @Fg2, TextWrapping = Wrap, Visibility = $IsEmpty << ToVisibility ]
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsError << ToVisibility ] {
                TextBlock [ Text = "Could not load the changes.", Foreground = @StateDangerInk ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap ]
            }
            StackPanel [ DockPanel.Dock = Top, Orientation = Vertical, Visibility = $IsDenied << ToVisibility ] {
                TextBlock [ Text = "You don't have access to approvals", Style = @UiLabel, Foreground = @Fg0 ]
                StackPanel [ Orientation = Horizontal, Margin = (0,4,0,0) ] {
                    TextBlock [ Text = "This needs access to your hive. Ask", Foreground = @Fg2, Margin = (0,0,4,0) ]
                    TextBlock [ Text = $OwnerContact, Foreground = @Fg1 ]
                }
            }

            ScrollViewer [ HorizontalScrollEnabled = false, Visibility = $IsPopulated << ToVisibility ] {
                StackPanel [ Orientation = Vertical ] {
                    TextBlock [ Text = "Nothing waits for a decision.", Foreground = @Fg2, Margin = (0,0,0,12),
                                Visibility = $HasNoPending << ToVisibility ]
                    TextBlock [ Text = $DeniedReason, Style = @UiCaption, Foreground = @StateWarningInk, TextWrapping = Wrap, Margin = (0,0,0,8),
                                Visibility = $DeniedReason << ToVisibility ]
                    ListBox [ Style = @TenantTableList, HorizontalAlignment = Stretch, ItemsSource = $Rows,
                              ItemTemplate = @ApprovalRowTemplate ]
                }
            }
        }
    }

    DataTemplate x:key="ApprovalRowTemplate" [ DataType = ApprovalRowViewModel ] {
        Border [ Style = @TenantPanel ] {
            StackPanel [ Orientation = Vertical ] {
                DockPanel {
                    TextBlock [ DockPanel.Dock = Right, Text = $StatusText, Style = @UiCaption, Foreground = @Fg2, VerticalAlignment = Center ]
                    TextBlock [ Text = $Sentence, Style = @UiLabel, Foreground = @Fg0, TextWrapping = Wrap ]
                }
                TextBlock [ Text = $ExpiryText, Style = @UiCaption, Foreground = @Fg2, Margin = (0,4,0,0) ]
                TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,8,0,0),
                            Visibility = $ErrorText << ToVisibility ]
                StackPanel [ Orientation = Horizontal, Margin = (0,8,0,0), Visibility = $IsPending << ToVisibility ] {
                    Button [ Variant = Primary, Command = $ApproveCommand, Margin = (0,0,8,0) ] {
                        TextBlock [ Text = "Approve" ]
                    }
                    Button [ Variant = Text, Command = $RejectCommand ] {
                        TextBlock [ Text = "Reject" ]
                    }
                    TextBlock [ Text = "Sending your decision...", Foreground = @Fg2, VerticalAlignment = Center, Margin = (12,0,0,0),
                                Visibility = $IsBusy << ToVisibility ]
                }
            }
        }
    }
}
