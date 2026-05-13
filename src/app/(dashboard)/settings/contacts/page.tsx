"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Mail,
  Pencil,
  Phone,
  Search,
  Users,
  Trash2,
  Filter,
  Download,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { Customer, CustomerContact } from "@/types/database";
import {
  EditContactDialog,
  type ContactFields,
} from "@/components/app/edit-contact-dialog";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { useCachedData } from "@/hooks/use-cached-data";

type CustomerOptionWithStatus = Pick<
  Customer,
  "id" | "name" | "fortnox_customer_number" | "status"
>;

type ContactWithCustomers = CustomerContact & {
  primaryCustomers: CustomerOptionWithStatus[];
  customers: CustomerOptionWithStatus[];
};

type ContactAdvancedFilters = {
  showDuplicates: boolean;
  showArchivedCustomerContacts: boolean;
  showMissingMail: boolean;
  showMissingPhone: boolean;
};

const DEFAULT_CONTACT_ADVANCED_FILTERS: ContactAdvancedFilters = {
  showDuplicates: false,
  showArchivedCustomerContacts: false,
  showMissingMail: false,
  showMissingPhone: false,
};

function escapeCsvValue(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function toCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",");
}

type ContactsPagePayload = {
  contacts: ContactWithCustomers[];
  customers: CustomerOptionWithStatus[];
};

const CONTACTS_DEFAULT_PAGE_SIZE = 12;

export default function ContactsPage() {
  const { user, isAdmin } = useUser();
  const { t } = useTranslation();
  const [search, setSearch] = React.useState("");
  const [pageIndex, setPageIndex] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(CONTACTS_DEFAULT_PAGE_SIZE);
  const [advancedFilters, setAdvancedFilters] =
    React.useState<ContactAdvancedFilters>(DEFAULT_CONTACT_ADVANCED_FILTERS);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingContact, setEditingContact] =
    React.useState<ContactWithCustomers | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [deletingContact, setDeletingContact] =
    React.useState<ContactWithCustomers | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const fetchContacts = React.useCallback(async (): Promise<ContactsPagePayload> => {
    const response = await fetch("/api/contacts", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as {
      contacts?: ContactWithCustomers[];
      customers?: CustomerOptionWithStatus[];
      error?: string;
    } | null;

    if (!response.ok) {
      toast.error(
        payload?.error ??
          t("settings.contacts.toast.loadFailed", "Failed to load contacts"),
      );
      return { contacts: [], customers: [] };
    }

    return {
      contacts: payload?.contacts ?? [],
      customers: payload?.customers ?? [],
    };
  }, [t]);

  const {
    data: contactsData,
    loading,
    refresh: refreshContacts,
  } = useCachedData<ContactsPagePayload>({
    key: `contacts.v1.${user.id}`,
    fetcher: fetchContacts,
    staleMs: 120000,
  });

  const contacts = React.useMemo(
    () => contactsData?.contacts ?? [],
    [contactsData],
  );
  const allCustomers = React.useMemo(
    () => contactsData?.customers ?? [],
    [contactsData],
  );

  const getVisibleRelatedCustomers = React.useCallback(
    (relatedCustomers: CustomerOptionWithStatus[]) => {
      if (advancedFilters.showArchivedCustomerContacts) return relatedCustomers;
      return relatedCustomers.filter(
        (customer) => customer.status !== "archived",
      );
    },
    [advancedFilters.showArchivedCustomerContacts],
  );

  const getVisibleRelations = React.useCallback(
    (contact: ContactWithCustomers) => {
      const primary = getVisibleRelatedCustomers(contact.primaryCustomers);
      const regular = getVisibleRelatedCustomers(contact.customers);
      return { primary, regular };
    },
    [getVisibleRelatedCustomers],
  );

  const contactsByArchivedToggle = React.useMemo(() => {
    if (advancedFilters.showArchivedCustomerContacts) return contacts;

    return contacts.filter((contact) => {
      const totalRelations =
        contact.primaryCustomers.length + contact.customers.length;
      if (totalRelations === 0) return true;

      const visibleRelations =
        getVisibleRelatedCustomers(contact.primaryCustomers).length +
        getVisibleRelatedCustomers(contact.customers).length;

      return visibleRelations > 0;
    });
  }, [
    contacts,
    advancedFilters.showArchivedCustomerContacts,
    getVisibleRelatedCustomers,
  ]);

  const duplicateEmails = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const contact of contactsByArchivedToggle) {
      const email = contact.email?.trim().toLowerCase();
      if (!email) continue;
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [email, count] of counts) {
      if (count > 1) dupes.add(email);
    }
    return dupes;
  }, [contactsByArchivedToggle]);

  const duplicateCount = React.useMemo(() => {
    return contactsByArchivedToggle.filter((c) => {
      const email = c.email?.trim().toLowerCase();
      return email && duplicateEmails.has(email);
    }).length;
  }, [contactsByArchivedToggle, duplicateEmails]);

  const filteredContacts = React.useMemo(() => {
    let result = contactsByArchivedToggle;

    if (advancedFilters.showDuplicates) {
      result = result.filter((contact) => {
        const email = contact.email?.trim().toLowerCase();
        return email && duplicateEmails.has(email);
      });
    }

    if (advancedFilters.showMissingMail) {
      result = result.filter((contact) => !contact.email?.trim());
    }

    if (advancedFilters.showMissingPhone) {
      result = result.filter((contact) => !contact.phone?.trim());
    }

    if (!search) return result;
    const query = search.toLowerCase();
    return result.filter((contact) => {
      const allCustomerNames = [
        ...getVisibleRelatedCustomers(contact.primaryCustomers),
        ...getVisibleRelatedCustomers(contact.customers),
      ]
        .map((customer) => customer.name.toLowerCase())
        .join(" ");
      return [
        contact.name,
        contact.email ?? "",
        contact.role ?? "",
        allCustomerNames,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [
    contactsByArchivedToggle,
    search,
    advancedFilters,
    duplicateEmails,
    getVisibleRelatedCustomers,
  ]);

  const pageCount = React.useMemo(
    () => Math.max(1, Math.ceil(filteredContacts.length / pageSize)),
    [filteredContacts.length, pageSize],
  );

  React.useEffect(() => {
    setPageIndex((current) => {
      if (current < 0) return 0;
      if (current >= pageCount) return pageCount - 1;
      return current;
    });
  }, [pageCount]);

  const paginatedContacts = React.useMemo(() => {
    const from = pageIndex * pageSize;
    const to = from + pageSize;
    return filteredContacts.slice(from, to);
  }, [filteredContacts, pageIndex, pageSize]);

  const pageStart = filteredContacts.length === 0 ? 0 : pageIndex * pageSize + 1;
  const pageEnd = Math.min(
    (pageIndex + 1) * pageSize,
    filteredContacts.length,
  );

  const activeFilterCount = React.useMemo(
    () =>
      [
        advancedFilters.showDuplicates,
        advancedFilters.showArchivedCustomerContacts,
        advancedFilters.showMissingMail,
        advancedFilters.showMissingPhone,
      ].filter(Boolean).length,
    [advancedFilters],
  );

  function toggleAdvancedFilter(key: keyof ContactAdvancedFilters) {
    setAdvancedFilters((previous) => ({
      ...previous,
      [key]: !previous[key],
    }));
  }

  function handleExportCsv() {
    if (filteredContacts.length === 0) {
      toast.error(t("settings.contacts.export.none", "No contacts to export"));
      return;
    }

    const headers = [
      t("settings.contacts.export.columns.name", "Name"),
      t("settings.contacts.export.columns.email", "Email"),
      t("settings.contacts.export.columns.phone", "Phone"),
      t("settings.contacts.export.columns.role", "Role"),
      t("settings.contacts.export.columns.primaryFor", "Primary contact for"),
      t("settings.contacts.export.columns.contactFor", "Contact for"),
    ];

    const rows = filteredContacts.map((contact) => {
      const visibleRelations = getVisibleRelations(contact);
      const primaryFor = visibleRelations.primary
        .map((customer) => customer.name)
        .join(" | ");
      const contactFor = visibleRelations.regular
        .map((customer) => customer.name)
        .join(" | ");

      return [
        contact.name ?? "",
        contact.email?.trim() ?? "",
        contact.phone?.trim() ?? "",
        contact.role?.trim() ?? "",
        primaryFor,
        contactFor,
      ];
    });

    const csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().slice(0, 10);
    const link = document.createElement("a");

    link.href = url;
    link.download = `contacts-${timestamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    toast.success(t("settings.contacts.export.success", "Contacts CSV exported"));
  }

  const existingPrimaryByCustomerId = React.useMemo(() => {
    const map: Record<
      string,
      { customerName: string; contactId: string; contactName: string }
    > = {};

    for (const contact of contacts) {
      for (const customer of contact.primaryCustomers) {
        if (!map[customer.id]) {
          map[customer.id] = {
            customerName: customer.name,
            contactId: contact.id,
            contactName: contact.name,
          };
        }
      }
    }

    return map;
  }, [contacts]);

  function openEditDialog(contact: ContactWithCustomers) {
    setEditingContact(contact);
    setDialogOpen(true);
  }

  function openDeleteDialog(contact: ContactWithCustomers) {
    setDeletingContact(contact);
    setDeleteDialogOpen(true);
  }

  async function syncPrimaryFields(customerIds: string[]) {
    const uniqueCustomerIds = Array.from(new Set(customerIds));
    if (uniqueCustomerIds.length === 0) return;

    const response = await fetch("/api/contacts/primary-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customerIds: uniqueCustomerIds }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      toast.error(
        payload?.error ??
          t(
            "settings.contacts.toast.syncPrimaryFailed",
            "Failed to sync primary contact fields to Fortnox",
          ),
      );
    }
  }

  async function handleSaveContact(
    payload: ContactFields & {
      primaryCustomerIds: string[];
      customerIds: string[];
    },
  ) {
    if (!editingContact) return;
    const supabase = createClient();
    const uniquePrimaryIds = Array.from(new Set(payload.primaryCustomerIds));
    const uniqueRegularIds = Array.from(
      new Set(
        payload.customerIds.filter(
          (customerId) => !uniquePrimaryIds.includes(customerId),
        ),
      ),
    );

    const { error: updateError } = await supabase
      .from("customer_contacts")
      .update({
        name: payload.name,
        first_name: payload.firstName,
        last_name: payload.lastName,
        role: payload.role,
        email: payload.email,
        phone: payload.phone,
        linkedin: payload.linkedin,
        notes: payload.notes,
      } as never)
      .eq("id", editingContact.id);

    if (updateError) {
      toast.error(t("settings.contacts.toast.updateFailed", "Failed to update contact"));
      throw updateError;
    }

    const existingPrimaryIds = new Set(
      editingContact.primaryCustomers.map((customer) => customer.id),
    );
    const existingRegularIds = new Set(
      editingContact.customers.map((customer) => customer.id),
    );
    const allExistingIds = new Set([
      ...existingPrimaryIds,
      ...existingRegularIds,
    ]);

    const newPrimarySet = new Set(uniquePrimaryIds);
    const newRegularSet = new Set(uniqueRegularIds);
    const removedPrimaryIds = [...existingPrimaryIds].filter(
      (customerId) => !newPrimarySet.has(customerId),
    );
    const allNewIds = new Set([...newPrimarySet, ...newRegularSet]);

    let conflictingLinkIds: string[] = [];
    let conflictingContactIds: string[] = [];

    if (uniquePrimaryIds.length > 0) {
      const { data: conflictingRows, error: conflictingError } = await supabase
        .from("customer_contact_links")
        .select("id, contact_id")
        .in("customer_id", uniquePrimaryIds)
        .eq("is_primary", true)
        .neq("contact_id", editingContact.id);

      if (conflictingError) {
        toast.error(t("settings.contacts.toast.validatePrimaryFailed", "Failed to validate primary contacts"));
        throw conflictingError;
      }

      const conflicts = (conflictingRows ?? []) as Array<{
        id: string;
        contact_id: string;
      }>;
      conflictingLinkIds = conflicts.map((row) => row.id);
      conflictingContactIds = Array.from(
        new Set(conflicts.map((row) => row.contact_id)),
      );
    }

    const idsToRemove = [...allExistingIds].filter(
      (existingId) => !allNewIds.has(existingId),
    );

    if (idsToRemove.length > 0) {
      const { error: removeError } = await supabase
        .from("customer_contact_links")
        .delete()
        .eq("contact_id", editingContact.id)
        .in("customer_id", idsToRemove);

      if (removeError) {
        toast.error(t("settings.contacts.toast.removeRelationsFailed", "Failed to remove customer relations"));
        throw removeError;
      }
    }

    const primaryToInsert = uniquePrimaryIds.filter(
      (cid) => !allExistingIds.has(cid),
    );
    const regularToInsert = uniqueRegularIds.filter(
      (cid) => !allExistingIds.has(cid),
    );

    const insertRows = [
      ...primaryToInsert.map((customerId) => ({
        customer_id: customerId,
        contact_id: editingContact.id,
        is_primary: true,
        relationship_label: null,
      })),
      ...regularToInsert.map((customerId) => ({
        customer_id: customerId,
        contact_id: editingContact.id,
        is_primary: false,
        relationship_label: null,
      })),
    ];

    if (insertRows.length > 0) {
      const { error: insertError } = await supabase
        .from("customer_contact_links")
        .insert(insertRows as never);

      if (insertError) {
        toast.error(t("settings.contacts.toast.addRelationsFailed", "Failed to add customer relations"));
        throw insertError;
      }
    }

    const upgradeToPrimary = uniquePrimaryIds.filter((cid) =>
      existingRegularIds.has(cid),
    );
    const downgradeToRegular = uniqueRegularIds.filter((cid) =>
      existingPrimaryIds.has(cid),
    );

    for (const customerId of upgradeToPrimary) {
      const { error } = await supabase
        .from("customer_contact_links")
        .update({ is_primary: true } as never)
        .eq("contact_id", editingContact.id)
        .eq("customer_id", customerId);

      if (error) {
        toast.error(t("settings.contacts.toast.updatePrimaryStatusFailed", "Failed to update primary status"));
        throw error;
      }
    }

    for (const customerId of downgradeToRegular) {
      const { error } = await supabase
        .from("customer_contact_links")
        .update({ is_primary: false } as never)
        .eq("contact_id", editingContact.id)
        .eq("customer_id", customerId);

      if (error) {
        toast.error(t("settings.contacts.toast.updatePrimaryStatusFailed", "Failed to update primary status"));
        throw error;
      }
    }

    if (conflictingLinkIds.length > 0) {
      const { error: removeConflictingError } = await supabase
        .from("customer_contact_links")
        .delete()
        .in("id", conflictingLinkIds);

      if (removeConflictingError) {
        toast.error(t("settings.contacts.toast.replacePrimaryFailed", "Failed to replace existing primary contacts"));
        throw removeConflictingError;
      }
    }

    for (const conflictingContactId of conflictingContactIds) {
      const { count, error: countError } = await supabase
        .from("customer_contact_links")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", conflictingContactId);

      if (countError) {
        toast.error(t("settings.contacts.toast.validateReplacedFailed", "Failed to validate replaced contacts"));
        throw countError;
      }

      if ((count ?? 0) === 0) {
        const { error: deleteContactError } = await supabase
          .from("customer_contacts")
          .delete()
          .eq("id", conflictingContactId);

        if (deleteContactError) {
          toast.error(t("settings.contacts.toast.cleanupReplacedFailed", "Failed to clean up replaced primary contact"));
          throw deleteContactError;
        }
      }
    }

    await syncPrimaryFields([...uniquePrimaryIds, ...removedPrimaryIds]);

    toast.success(t("settings.contacts.toast.updated", "Contact updated"));
    setEditingContact(null);
    await refreshContacts();
  }

  async function handleDelete() {
    if (!deletingContact) return;
    setDeleting(true);
    const supabase = createClient();

    const { error: unlinkError } = await supabase
      .from("customer_contact_links")
      .delete()
      .eq("contact_id", deletingContact.id);

    if (unlinkError) {
      toast.error(t("settings.contacts.toast.deleteFailed", "Failed to delete contact"));
      setDeleting(false);
      return;
    }

    const { error: deleteError } = await supabase
      .from("customer_contacts")
      .delete()
      .eq("id", deletingContact.id);

    if (deleteError) {
      toast.error(t("settings.contacts.toast.deleteFailed", "Failed to delete contact"));
      setDeleting(false);
      return;
    }

    toast.success(t("settings.contacts.toast.deleted", "Contact deleted"));
    setDeleting(false);
    setDeleteDialogOpen(false);
    setDeletingContact(null);
    await refreshContacts();
  }

  // Contacts is now visible to all authenticated roles (user, team_lead,
  // admin). The previous admin-only gate hid the whole page from regular
  // users; now they can browse and use it. If specific destructive actions
  // need to stay admin-only, gate them inline on isAdmin instead of gating
  // the whole page.
  void isAdmin;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("settings.contacts.searchPlaceholder", "Search contacts or customers...")}
            className="pl-9"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={handleExportCsv}
            disabled={loading || filteredContacts.length === 0}
          >
            <Download className="size-3.5" />
            {t("settings.contacts.export.csv", "Export CSV")}
          </Button>
          
          {filteredContacts.length > 0 ? (
            <>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPageIndex(0);
                }}
                className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                aria-label={t(
                  "settings.contacts.pagination.perPage",
                  "Cards per page",
                )}
              >
                <option value={12}>
                  {t("settings.contacts.pagination.perPage12", "12 / page")}
                </option>
                <option value={24}>
                  {t("settings.contacts.pagination.perPage24", "24 / page")}
                </option>
                <option value={48}>
                  {t("settings.contacts.pagination.perPage48", "48 / page")}
                </option>
              </select>
              <span className="text-sm text-muted-foreground">
                {pageIndex + 1} {t("settings.contacts.pagination.of", "of")}{" "}
                {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9"
                onClick={() =>
                  setPageIndex((current) => Math.max(current - 1, 0))
                }
                disabled={pageIndex === 0}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9"
                onClick={() =>
                  setPageIndex((current) =>
                    Math.min(current + 1, pageCount - 1),
                  )
                }
                disabled={pageIndex >= pageCount - 1}
              >
                <ChevronRight className="size-4" />
              </Button>
            </>
          ) : null}

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5">
                <Filter className="size-3.5" />
                {t("settings.contacts.filters", "Filters")}
                {activeFilterCount > 0 ? (
                  <Badge
                    variant="secondary"
                    className="ml-0.5 h-5 min-w-5 px-1 text-xs"
                  >
                    {activeFilterCount}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3">
              <div>
                <p className="text-sm font-medium">
                  {t("settings.contacts.advancedFiltering", "Advanced filtering")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.contacts.advancedFilteringDescription",
                    "Refine contacts with checkbox-based filters.",
                  )}
                </p>
              </div>

              <div className="space-y-2">
                {[
                  {
                    key: "showDuplicates" as const,
                    label: `${t("settings.contacts.filter.duplicates", "Duplicates")}${duplicateCount > 0 ? ` (${duplicateCount})` : ""}`,
                  },
                  {
                    key: "showMissingMail" as const,
                    label: t("settings.contacts.filter.missingMail", "Missing Mail"),
                  },
                  {
                    key: "showMissingPhone" as const,
                    label: t("settings.contacts.filter.missingPhone", "Missing Phone"),
                  },
                  {
                    key: "showArchivedCustomerContacts" as const,
                    label: t(
                      "settings.contacts.filter.showArchivedCustomerContacts",
                      "Show contacts for archived customers",
                    ),
                  },
                ].map((item) => {
                  const id = `contact-advanced-filter-${item.key}`;
                  return (
                    <label
                      key={item.key}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={advancedFilters[item.key]}
                        onCheckedChange={() => toggleAdvancedFilter(item.key)}
                      />
                      <span>{item.label}</span>
                    </label>
                  );
                })}
              </div>

              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-0 text-xs text-muted-foreground"
                  onClick={() =>
                    setAdvancedFilters(DEFAULT_CONTACT_ADVANCED_FILTERS)
                  }
                  disabled={activeFilterCount === 0}
                >
                  {t("settings.contacts.clearFilters", "Clear filters")}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {filteredContacts.length === 0
          ? `${t("settings.contacts.showing", "Showing")} 0 ${t("settings.contacts.of", "of")} ${contactsByArchivedToggle.length} ${t("settings.contacts.contacts", "contacts")}`
          : `${t("settings.contacts.showing", "Showing")} ${pageStart}–${pageEnd} ${t("settings.contacts.of", "of")} ${filteredContacts.length} ${t("settings.contacts.contacts", "contacts")}`}
      </p>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-48 animate-pulse rounded-lg border bg-muted"
            />
          ))}
        </div>
      ) : filteredContacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("settings.contacts.empty.title", "No contacts")}
          description={t(
            "settings.contacts.empty.description",
            "Contacts linked to customers will appear here.",
          )}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {paginatedContacts.map((contact) => {
            const visibleRelations = getVisibleRelations(contact);
            const email = contact.email?.trim() || null;
            const phone = contact.phone?.trim() || null;

            return (
              <Card key={contact.id} className="group/card gap-0">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="min-w-0 space-y-0.5 text-base">
                      <div className="truncate">{contact.name}</div>
                      {contact.role && (
                        <p className="text-xs font-normal text-muted-foreground">
                          {contact.role}
                        </p>
                      )}
                    </CardTitle>
                    <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/card:opacity-100 group-hover/card:pointer-events-auto group-focus-within/card:opacity-100 group-focus-within/card:pointer-events-auto">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => openEditDialog(contact)}
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">
                          {t("settings.contacts.editContact", "Edit contact")}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => openDeleteDialog(contact)}
                      >
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">
                          {t("settings.contacts.deleteContact", "Delete contact")}
                        </span>
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="space-y-1.5 text-sm">
                    {email ? (
                      <a
                        href={`mailto:${email}`}
                        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Mail className="size-3.5" />
                        <span className="truncate">{email}</span>
                      </a>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Mail className="size-3.5" />
                        <span>–</span>
                      </div>
                    )}
                    {phone ? (
                      <a
                        href={`tel:${phone}`}
                        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Phone className="size-3.5" />
                        <span>{phone}</span>
                      </a>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Phone className="size-3.5" />
                        <span>–</span>
                      </div>
                    )}
                  </div>

                  {visibleRelations.primary.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("settings.contacts.primaryContactFor", "Primary contact for:")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {visibleRelations.primary.map((customer) => (
                          <Link
                            key={customer.id}
                            href={`/customers/${customer.id}`}
                          >
                            <Badge
                              variant="outline"
                              className="max-w-[170px] cursor-pointer px-2 py-0 text-xs font-normal leading-5 hover:bg-muted"
                            >
                              <span className="block truncate">
                                {customer.name}
                              </span>
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {visibleRelations.regular.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("settings.contacts.contactFor", "Contact for:")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {visibleRelations.regular.map((customer) => (
                          <Link
                            key={customer.id}
                            href={`/customers/${customer.id}`}
                          >
                            <Badge
                              variant="outline"
                              className="max-w-[170px] cursor-pointer px-2 py-0 text-xs font-normal leading-5 hover:bg-muted"
                            >
                              <span className="block truncate">
                                {customer.name}
                              </span>
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <EditContactDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={editingContact}
        customers={allCustomers}
        existingPrimaryByCustomerId={existingPrimaryByCustomerId}
        initialPrimaryCustomerIds={
          editingContact?.primaryCustomers.map((c) => c.id) ?? []
        }
        initialCustomerIds={editingContact?.customers.map((c) => c.id) ?? []}
        onSave={handleSaveContact}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("settings.contacts.deleteDialog.title", "Delete Contact")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.contacts.deleteDialog.descriptionPrefix", "Are you sure you want to delete")}{" "}
              <span className="font-medium text-foreground">
                {deletingContact?.name}
              </span>
              ? {t("settings.contacts.deleteDialog.descriptionSuffix", "This action cannot be undone.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting
                ? t("settings.contacts.deleting", "Deleting...")
                : t("settings.contacts.deleteContact", "Delete Contact")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
