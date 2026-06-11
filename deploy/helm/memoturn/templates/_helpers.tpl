{{- define "memoturn.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "memoturn.labels" -}}
app.kubernetes.io/name: memoturn
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "memoturn.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-dataplane" (include "memoturn.fullname" .)) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "memoturn.minioSecretName" -}}
{{- printf "%s-minio" (include "memoturn.fullname" .) -}}
{{- end -}}

{{- define "memoturn.objectStoreUrl" -}}
{{- if eq .Values.objectStorage.backend "minio" -}}
s3://{{ .Values.objectStorage.s3.bucket }}
{{- else -}}
s3://{{ .Values.objectStorage.s3.bucket }}
{{- end -}}
{{- end -}}
