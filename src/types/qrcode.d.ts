declare module "qrcode" {
  interface QRCode {
    toDataURL(
      text: string,
      options?: {
        margin?: number;
        width?: number;
        errorCorrectionLevel?: "L" | "M" | "Q" | "H";
        error?: (err: Error) => void;
      },
    ): Promise<string>;
  }
  const QRCode: QRCode;
  export default QRCode;
}
