"""Detect objects in a set of images with YOLO.

Usage:
  .venv/bin/python detect.py IMAGE_OR_FOLDER [...] [--out results] [--conf 0.25]
  .venv/bin/python detect.py photo.jpg --classes "ring,earring,bracelet,compact mirror"

Without --classes it uses YOLO trained on COCO (80 everyday classes such as person,
car, bottle, cell phone). With --classes it uses YOLO-World, which finds whatever
object names you give it.
"""

import argparse
import json
from pathlib import Path

from ultralytics import YOLO

IMAGE_TYPES = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}


def collect(paths):
    images = []
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            images += sorted(p for p in path.rglob('*') if p.suffix.lower() in IMAGE_TYPES)
        elif path.suffix.lower() in IMAGE_TYPES:
            images.append(path)
        else:
            raise SystemExit(f'Not an image or folder: {path}')
    if not images:
        raise SystemExit('No images found.')
    return images


def load_model(model_name, classes):
    if classes:
        model = YOLO(model_name or 'yolov8s-worldv2.pt')
        model.set_classes(classes)
        return model
    return YOLO(model_name or 'yolo11m.pt')


def detect(images, model, conf, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    report = []
    for image in images:
        result = model.predict(str(image), conf=conf, verbose=False)[0]
        objects = []
        for box in result.boxes:
            x1, y1, x2, y2 = (round(v, 1) for v in box.xyxy[0].tolist())
            objects.append({
                'label': result.names[int(box.cls)],
                'confidence': round(float(box.conf), 3),
                'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
            })
        objects.sort(key=lambda item: item['confidence'], reverse=True)
        annotated = out_dir / f'{image.stem}_detected.jpg'
        result.save(filename=str(annotated))
        counts = {}
        for item in objects:
            counts[item['label']] = counts.get(item['label'], 0) + 1
        report.append({
            'image': str(image),
            'width': result.orig_shape[1],
            'height': result.orig_shape[0],
            'counts': counts,
            'objects': objects,
            'annotated': str(annotated),
        })
    return report


def main():
    parser = argparse.ArgumentParser(description='Detect objects in images with YOLO.')
    parser.add_argument('inputs', nargs='+', help='Image files and/or folders')
    parser.add_argument('--out', default='results', help='Output folder (default: results)')
    parser.add_argument('--conf', type=float, default=0.25, help='Minimum confidence, 0-1 (default: 0.25)')
    parser.add_argument('--classes', default='', help='Comma-separated object names to look for (uses YOLO-World)')
    parser.add_argument('--model', default='', help='Override the model weights file')
    args = parser.parse_args()

    classes = [name.strip() for name in args.classes.split(',') if name.strip()]
    images = collect(args.inputs)
    model = load_model(args.model, classes)
    out_dir = Path(args.out)
    report = detect(images, model, args.conf, out_dir)

    (out_dir / 'detections.json').write_text(json.dumps(report, indent=2))
    for entry in report:
        found = ', '.join(f'{count} {label}' for label, count in entry['counts'].items()) or 'nothing'
        print(f"{entry['image']}: {found}")
        for item in entry['objects']:
            print(f"  {item['label']:<16} {item['confidence']:.2f}  {item['box']}")
    print(f'\nSaved {out_dir / "detections.json"} and annotated images in {out_dir}/')


if __name__ == '__main__':
    main()
