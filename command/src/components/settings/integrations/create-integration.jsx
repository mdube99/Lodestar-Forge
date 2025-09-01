"use client";

import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Tag } from "@/components/common/tag";

import { addIntegration } from "@/actions/integrations";

export function CreateIntegration() {
    const [dialogOpen, setDialogOpen] = useState(false);

    const [name, setName] = useState("");
    const [nameError, setNameError] = useState(false);

    const [integration, setIntegration] = useState("");
    const [integrationError, setIntegrationError] = useState(false);

    const [keyId, setKeyId] = useState("");
    const [keyIdError, setKeyIdError] = useState(false);

    const [secretKey, setSecretKey] = useState("");
    const [secretKeyError, setSecretKeyError] = useState(false);

    const [useIamRole, setUseIamRole] = useState(false);

    const addIntegrationHandler = async () => {
        if (!name) return setNameError(true);
        if (!integration) return setIntegrationError(true);

        // Validate credentials based on IAM role usage
        if (integration === "aws" && !useIamRole) {
            if (!keyId) return setKeyIdError(true);
            if (!secretKey) return setSecretKeyError(true);
        } else if (integration !== "aws" && !secretKey) {
            return setSecretKeyError(true);
        }

        const result = await addIntegration(
            name,
            integration,
            useIamRole ? "" : keyId,
            useIamRole && integration === "aws" ? "" : secretKey,
            useIamRole,
        );
        if (result) {
            setName("");
            setIntegration("");
            setKeyId("");
            setSecretKey("");
            setUseIamRole(false);
            setNameError(false);
            setIntegrationError(false);
            setKeyIdError(false);
            setSecretKeyError(false);
            setDialogOpen(false);
        }
    };

    return (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
                <Button>Add Integration</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add Integration</DialogTitle>
                    <DialogDescription>
                        Complete the form below to add a new integration.
                        Required fields are marked with an asterisk.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="name">Name*</Label>
                        <Input
                            id="name"
                            placeholder="AWS Global Access"
                            value={name}
                            className={nameError ? "border border-red-500" : ""}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="integration">Integration*</Label>
                        {integration === "tailscale" && (
                            <p className="text-amber-500 text-xs">
                                Tailscale API keys expire every 90 days. Be sure
                                to keep this value up to date.
                            </p>
                        )}
                        <Select
                            value={integration}
                            onValueChange={(value) => {
                                setIntegration(value);
                                // Reset IAM role when changing platforms
                                if (value !== "aws") {
                                    setUseIamRole(false);
                                }
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select a integration" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectLabel>Integrations</SelectLabel>
                                    <SelectItem value="aws">
                                        <Tag color="amber">aws</Tag>
                                    </SelectItem>
                                    <SelectItem value="tailscale">
                                        <Tag color="teal">tailscale</Tag>
                                    </SelectItem>
                                    <SelectItem value="digitalocean">
                                        <Tag color="blue">digitalocean</Tag>
                                    </SelectItem>
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </div>
                    {integration === "aws" && (
                        <div className="flex items-center gap-2">
                            <Checkbox 
                                id="useIamRole" 
                                checked={useIamRole}
                                onCheckedChange={setUseIamRole}
                            />
                            <Label 
                                htmlFor="useIamRole" 
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                            >
                                Use IAM Role
                            </Label>
                        </div>
                    )}
                    {integration === "aws" && useIamRole && (
                        <p className="text-blue-500 text-xs">
                            When using IAM roles, ensure your EC2 instance has the necessary IAM role attached with appropriate AWS permissions. No static credentials will be stored.
                        </p>
                    )}
                    {integration === "aws" && !useIamRole && (
                        <div className="grid gap-2">
                            <Label htmlFor="keyId">Key ID*</Label>
                            <Input
                                id="keyId"
                                placeholder="AKIAIOSFODNN7EXAMPLE"
                                value={keyId}
                                className={
                                    keyIdError ? "border border-red-500" : ""
                                }
                                onChange={(e) => setKeyId(e.target.value)}
                            />
                        </div>
                    )}
                    {(!useIamRole || integration !== "aws") && (
                        <div className="grid gap-2">
                            <Label htmlFor="secretKey">Secret Key*</Label>
                            <Input
                                id="secretKey"
                                placeholder="••••••••••••"
                                value={secretKey}
                                type="password"
                                className={
                                    secretKeyError ? "border border-red-500" : ""
                                }
                                onChange={(e) => setSecretKey(e.target.value)}
                            />
                        </div>
                    )}
                </div>
                <DialogFooter>
                    {/* <Button
            disabled={
              integration === "" ||
              secretKey === "" ||
              (integration === "aws" && keyId == "")
            }
            variant={"secondary"}
          >
            Test
          </Button>*/}
                    <Button
                        type="button"
                        disabled={
                            name == "" ||
                            integration == "" ||
                            (integration === "aws" && !useIamRole && (keyId == "" || secretKey == "")) ||
                            (integration !== "aws" && secretKey == "")
                        }
                        onClick={() => addIntegrationHandler()}
                    >
                        Add
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
